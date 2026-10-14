#!/usr/bin/env node
// Quirk depot: a small HTTP backend plus an MCP server in front of it, for the
// harness tuner bench. The tool schema does not show the rules of the depot.
// Four classes of rule, each with a different feedback signal:
//   format    a wrong field returns ERR_FORMAT with one rule (the first violated one)
//   paging    a search result has `more: true`, and the page field has its own format
//   stale     depot_stock without one extra field succeeds with an old count and a note
//   protocol  depot_confirm needs a pin derived from the hold; a wrong pin voids the hold
// Each job (cell) has a small call quota, so an agent that does not know the
// rules uses its quota on errors.
//
// The rules come from a seed, so the same suite can require different rules:
//   node quirk-server.mjs --port 4747 --seed 1 --quota 5
//   curl -X POST localhost:4747/admin/profile -d '{"seed":2}'   # change live
//   node quirk-server.mjs --make-tasks <dir> [--port 4747]      # write the task suite
//   node quirk-server.mjs --oracle --seed 1                     # the rules as a learned.md
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const fnv = (text) => {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash;
};

// An irregular catalog: not every material has every shape, so a list answer is not guessable.
const MATERIALS = ["copper", "brass", "steel", "nylon", "zinc", "iron", "rubber"];
const SHAPES = ["flange", "elbow", "gasket", "bushing", "bracket", "coupling", "valve"];
const PARTS = MATERIALS.flatMap((material) => SHAPES.map((shape) => `${material} ${shape}`)).filter((name) => fnv(name) % 5 !== 0);
const REGIONS = ["north", "east", "south", "west"];
const PAGE_SIZE = 3;
const partId = (index) => `P-${1001 + index}`;

// --- backend data (does not depend on the seed) ---
export const stock = (id, region, isoDate) => (fnv(`${id}|${region}|${isoDate}`) % 900) + 17;
const staleStock = (id, region, isoDate) => {
  const old = stock(id, region, `${isoDate}|old`);
  return old === stock(id, region, isoDate) ? old + 1 : old;
};
const cents = (id, qty) => {
  const total = ((fnv(id) % 4000) + 250) * qty;
  return qty >= 50 ? Math.round(total * 0.9) : total;
};
export const price = (id, qty) => (cents(id, qty) / 100).toFixed(2);
export const orderCode = (id, qty, region) => `ORD-${10000 + (fnv(`${id}|${qty}|${region}|order`) % 90000)}`;
const namesWith = (words) => PARTS.map((name, index) => ({ id: partId(index), name })).filter((part) => words.every((word) => part.name.split(" ").includes(word)));

// --- rule profile (depends on the seed) ---
const VARIANTS = {
  envelope: [["[[", "]]"], ["<", ">"], ["q:", ";"]],
  join: ["+", "_", "::"],
  page: [
    { make: (n) => `p${n}`, rule: "p then the page number. Example: page 3 becomes p3" },
    { make: (n) => `#${n}`, rule: "a hash sign then the page number. Example: page 3 becomes #3" },
    { make: (n) => `${n}/`, rule: "the page number then a slash. Example: page 3 becomes 3/" },
  ],
  part: [
    { make: (n) => `${n}/P`, read: /^(\d{4})\/P$/, rule: "number, slash, P. Example: catalog id P-7731 becomes 7731/P" },
    { make: (n) => `P#${n}`, read: /^P#(\d{4})$/, rule: "P, hash sign, number. Example: catalog id P-7731 becomes P#7731" },
    { make: (n) => `p${n}`, read: /^p(\d{4})$/, rule: "lower-case p then the number. Example: catalog id P-7731 becomes p7731" },
  ],
  region: [
    { make: (r) => r.slice(0, 3).toUpperCase(), rule: "the first three letters in upper case. Example: central becomes CEN" },
    { make: (r) => `R-${r}`, rule: "R- then the lower-case name. Example: central becomes R-central" },
    { make: (r) => String(REGIONS.indexOf(r) + 1), rule: "a compass number: north is 1, east is 2, south is 3, west is 4" },
  ],
  date: [
    { make: ([y, m, d]) => `${d}.${m}.${y}`, rule: "DD.MM.YYYY. Example: 2031-07-09 becomes 09.07.2031" },
    { make: ([y, m, d]) => `${y}${m}${d}`, rule: "YYYYMMDD with no separators. Example: 2031-07-09 becomes 20310709" },
    { make: ([y, m, d]) => `${m}/${d}/${y}`, rule: "MM/DD/YYYY. Example: 2031-07-09 becomes 07/09/2031" },
  ],
  qty: [
    { make: (n) => `${n}ea`, read: /^(\d+)ea$/, rule: "the number then ea. Example: 7 becomes 7ea" },
    { make: (n) => `x${n}`, read: /^x(\d+)$/, rule: "x then the number. Example: 7 becomes x7" },
    { make: (n) => `${n} pcs`, read: /^(\d+) pcs$/, rule: "the number, one space, pcs. Example: 7 becomes 7 pcs" },
  ],
  cur: ["usd", "USD", "$"],
  fresh: [["live", "yes"], ["mode", "live"], ["cache", "off"]],
  pin: [
    { make: (hold) => [...hold].reverse().join(""), rule: "the digits of the hold id in reverse order. Example: hold H-40217 has pin 71204" },
    { make: (hold) => String([...hold].reduce((sum, digit) => sum + Number(digit), 0)), rule: "the sum of the digits of the hold id. Example: hold H-40217 has pin 14" },
    { make: (hold, qty) => String(Number(hold) + qty), rule: "the number of the hold id plus the reserved quantity. Example: hold H-40217 for 5 units has pin 40222" },
  ],
};

export const makeProfile = (seed) => {
  const pick = (name) => VARIANTS[name][fnv(`${seed}:${name}`) % VARIANTS[name].length];
  return { seed, ...Object.fromEntries(Object.keys(VARIANTS).map((name) => [name, pick(name)])) };
};

const state = { profile: makeProfile(1), quota: 5, cells: new Map() };
const cellStats = (cell) => {
  if (!state.cells.has(cell)) state.cells.set(cell, { calls: 0, ok: 0, holds: new Map(), log: [] });
  return state.cells.get(cell);
};

class DepotError extends Error {}
const fail = (message) => { throw new DepotError(message); };
const bad = (field, rule) => fail(`ERR_FORMAT [${field}]: ${rule}`);
const text = (value, field) => typeof value === "string" && value.length > 0 ? value : bad(field, `${field} is required and must be a string`);

const readPart = (value, p) => {
  const match = p.part.read.exec(text(value, "part"));
  if (!match) bad("part", `part must be ${p.part.rule}`);
  const id = `P-${match[1]}`;
  if (!PARTS[Number(match[1]) - 1001]) fail(`ERR_NOT_FOUND: no part ${id}`);
  return id;
};
const readRegion = (value, p) => REGIONS.find((name) => p.region.make(name) === text(value, "region")) ?? bad("region", `region must be ${p.region.rule}`);
const readQty = (value, p) => Number((p.qty.read.exec(text(value, "qty")) ?? bad("qty", `qty must be ${p.qty.rule}`))[1]);

// Each handler checks its fields in a fixed order and reports only the first violation.
const handlers = {
  depot_search({ q, page }, p) {
    const [open, close] = p.envelope;
    const raw = text(q, "q");
    if (!raw.startsWith(open) || !raw.endsWith(close)) bad("q", `q must be wrapped as ${open}...${close}`);
    const inner = raw.slice(open.length, raw.length - close.length);
    if (inner !== inner.toUpperCase() || /\s/.test(inner)) bad("q", `inside the wrapper, the words must be upper case and joined with ${p.join} (no spaces). Example: ${open}OAK${p.join}PANEL${close}`);
    const matches = namesWith(inner.toLowerCase().split(p.join).filter(Boolean));
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    const number = page === undefined ? 1 : Array.from({ length: pages }, (_, index) => index + 1).find((n) => p.page.make(n) === page);
    if (!number) bad("page", `page must be ${p.page.rule}. This search has ${pages} page(s)`);
    return { matches: matches.slice((number - 1) * PAGE_SIZE, number * PAGE_SIZE), more: number < pages };
  },
  depot_stock(args, p) {
    const id = readPart(args.part, p);
    const region = readRegion(args.region, p);
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const candidates = [text(args.date, "date")].flatMap((value) => {
      // Recover the ISO date by trying every reading; accept only the active format.
      const digits = value.match(/\d+/g) ?? [];
      const joined = value.replace(/\D/g, "");
      return [[digits[2], digits[1], digits[0]], [joined.slice(0, 4), joined.slice(4, 6), joined.slice(6, 8)], [digits[2], digits[0], digits[1]]]
        .filter((parts) => parts.every(Boolean) && iso.test(parts.join("-")) && p.date.make(parts) === value);
    });
    if (candidates.length === 0) bad("date", `date must be ${p.date.rule}`);
    const date = candidates[0].join("-");
    // No error on a missing fresh field: the call succeeds with an old count.
    const [key, value] = p.fresh;
    return args[key] === value
      ? { part: id, region, date, units: stock(id, region, date), snapshot: "LIVE" }
      : { part: id, region, date, units: staleStock(id, region, date), snapshot: "STALE", note: `This count is from an old snapshot. Add ${key}: "${value}" for the live count.` };
  },
  depot_price({ part, qty, cur }, p) {
    const id = readPart(part, p);
    const count = readQty(qty, p);
    if (cur !== p.cur) bad("cur", `cur is required and must be exactly ${p.cur}`);
    return { part: id, qty: count, total: price(id, count) };
  },
  depot_reserve({ part, qty, region }, p, stats, cell) {
    const hold = String(10000 + (fnv(`${cell}|${stats.calls}`) % 90000));
    stats.holds.set(hold, { id: readPart(part, p), qty: readQty(qty, p), region: readRegion(region, p) });
    return { hold: `H-${hold}`, note: "Confirm this hold to get the order code." };
  },
  depot_confirm({ hold, pin }, p, stats) {
    const number = /^H-(\d{5})$/.exec(text(hold, "hold"))?.[1];
    const held = stats.holds.get(number);
    if (!held) fail(`ERR_HOLD: no active hold ${hold}. Reserve first.`);
    stats.holds.delete(number);
    if (pin !== p.pin.make(number, held.qty)) fail(`ERR_PIN: pin is required and must be ${p.pin.rule}. This hold is void now. Reserve again.`);
    return { order: orderCode(held.id, held.qty, held.region) };
  },
};

const callDepot = (cell, tool, args) => {
  const stats = cellStats(cell);
  stats.calls += 1;
  let ok = false;
  let message;
  if (stats.calls > state.quota) message = `ERR_QUOTA: this job used all ${state.quota} depot calls. No more calls are possible.`;
  else {
    try {
      message = JSON.stringify(handlers[tool](args ?? {}, state.profile, stats, cell));
      ok = true;
      stats.ok += 1;
    } catch (error) {
      if (!(error instanceof DepotError)) throw error;
      message = error.message;
    }
  }
  stats.log.push({ tool, args, ok, message });
  return { ok, message };
};

const NOTE = "Input formats are strict and site-specific. A wrong format returns an error with one rule. Each job has a small quota of depot calls.";
const TOOLS = [
  { name: "depot_search", description: `Find parts by words of the name. Returns at most ${PAGE_SIZE} matches for each page. ${NOTE}`, properties: { q: "search text", page: "page (optional)" } },
  { name: "depot_stock", description: `Units in stock for one part, region, and date. ${NOTE}`, properties: { part: "part id", region: "region", date: "date" } },
  { name: "depot_price", description: `Total price for a quantity of one part. ${NOTE}`, properties: { part: "part id", qty: "quantity", cur: "currency" } },
  { name: "depot_reserve", description: `Reserve a quantity of one part in one region. Returns a hold id. ${NOTE}`, properties: { part: "part id", qty: "quantity", region: "region" } },
  { name: "depot_confirm", description: `Confirm a hold. Returns the order code. ${NOTE}`, properties: { hold: "hold id", pin: "pin" } },
].map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: { type: "object", properties: Object.fromEntries(Object.entries(tool.properties).map(([key, description]) => [key, { type: "string", description }])) },
}));

/** The complete rules of a profile as a learned.md: the upper limit for the tuner. */
export const oracle = (p = state.profile) => {
  const [open, close] = p.envelope;
  const example = { part: p.part.make(1004), region: p.region.make("west"), date: p.date.make(["2026", "04", "13"]), qty: p.qty.make(31) };
  return [
    "- Call the depot tools from `fabric_exec` code as `await mcp.depot.depot_search({...})`, `mcp.depot.depot_stock`, `mcp.depot.depot_price`, `mcp.depot.depot_reserve`, `mcp.depot.depot_confirm`. All field values are strings. A job has a quota of 5 depot calls, and a failed call uses quota.",
    `- \`depot_search\` field \`q\`: the words in upper case, joined with \`${p.join}\`, wrapped as \`${open}...${close}\`. Example: \`{q: '${open}BRASS${p.join}ELBOW${close}'}\`. One word is permitted.`,
    `- \`depot_search\` returns at most ${PAGE_SIZE} matches. When the result has \`more: true\`, call again with the same \`q\` and \`page\` as ${p.page.rule}. Page 2 is \`'${p.page.make(2)}'\`.`,
    `- Field \`part\`: ${p.part.rule}. Example: \`'${example.part}'\`.`,
    `- Field \`region\`: ${p.region.rule}. The values are ${REGIONS.map((name) => `${name} = \`'${p.region.make(name)}'\``).join(", ")}.`,
    `- Field \`date\`: ${p.date.rule}.`,
    `- Field \`qty\`: ${p.qty.rule}.`,
    `- \`depot_price\` field \`cur\`: exactly \`'${p.cur}'\`. Example: \`{part: '${example.part}', qty: '${example.qty}', cur: '${p.cur}'}\`.`,
    `- \`depot_stock\`: always add \`${p.fresh[0]}: '${p.fresh[1]}'\`. Without it the call succeeds but returns an old, wrong count. Example: \`{part: '${example.part}', region: '${example.region}', date: '${example.date}', ${p.fresh[0]}: '${p.fresh[1]}'}\`.`,
    `- \`depot_confirm\` fields: \`hold\` exactly as \`depot_reserve\` returned it, and \`pin\` as ${p.pin.rule}. A wrong pin voids the hold.`,
    "",
  ].join("\n");
};

const describeProfile = (p = state.profile) => ({
  seed: p.seed,
  quota: state.quota,
  rules: {
    "depot_search.q": `${p.envelope[0]}WORD${p.join}WORD${p.envelope[1]} (upper case)`,
    "depot_search.page": p.page.rule, part: p.part.rule, region: p.region.rule, date: p.date.rule, qty: p.qty.rule, cur: p.cur,
    "depot_stock fresh field": `${p.fresh[0]}: ${p.fresh[1]}`, "depot_confirm.pin": p.pin.rule,
  },
});

// --- task suite: 8 kinds of question in each of 3 disjoint sets. Answers do not depend on the seed. ---
const KINDS = ["id", "stock", "price", "both", "order", "compare", "total", "list"];
const makeTasks = (dir, port) => {
  const url = `http://127.0.0.1:${port}`;
  const splits = { feedback: [], scoring: [], heldout: [] };
  // Words with more than one page of matches, one for each set.
  const listWords = [...MATERIALS, ...SHAPES].filter((word) => namesWith([word]).length > PAGE_SIZE);
  let nextPart = 0;
  Object.keys(splits).forEach((split, setIndex) => KINDS.forEach((kind, kindIndex) => {
    const index = setIndex * KINDS.length + kindIndex;
    const name = `${split[0]}${kindIndex + 1}-${kind}`;
    const take = () => { const part = { id: partId(nextPart), name: PARTS[nextPart] }; nextPart += 1; return part; };
    const a = kind === "list" ? undefined : take();
    const b = kind === "compare" || kind === "total" ? take() : undefined;
    const region = REGIONS[index % 4];
    const date = `2026-0${(index % 9) + 1}-${10 + (index % 18)}`;
    const qty = 6 + index * 3;
    const word = listWords[(setIndex * 3) % listWords.length];
    const more = b && stock(a.id, region, date) >= stock(b.id, region, date) ? a : b;
    // [question, answer, number of successful depot calls that the task needs]
    const [question, want, need] = {
      id: () => [`What is the catalog id of the part named "${a.name}"?`, a.id, 1],
      stock: () => [`How many units of the part named "${a.name}" are in stock in the ${region} region on ${date}? Give the live count.`, String(stock(a.id, region, date)), 2],
      price: () => [`What is the total price for ${qty} units of the part named "${a.name}"? Pay in US dollars.`, price(a.id, qty), 2],
      both: () => [`For the part named "${a.name}": what is the live count of units in stock in the ${region} region on ${date}, and what is the total price for ${qty} units in US dollars? Give the answer as UNITS,PRICE (example: 12,34.50).`, `${stock(a.id, region, date)},${price(a.id, qty)}`, 3],
      order: () => [`Place an order: reserve ${qty} units of the part named "${a.name}" in the ${region} region, then confirm the reservation. What is the order code?`, orderCode(a.id, qty, region), 3],
      compare: () => [`Which of the parts named "${a.name}" and "${b.name}" has the larger live count of units in stock in the ${region} region on ${date}? Give the answer as CATALOG_ID,UNITS for that part (example: P-1001,250).`, `${more.id},${stock(more.id, region, date)}`, 4],
      total: () => [`What is the total price in US dollars for ${qty} units of the part named "${a.name}" plus ${qty + 20} units of the part named "${b.name}"? Give one number with two decimals.`, ((cents(a.id, qty) + cents(b.id, qty + 20)) / 100).toFixed(2), 4],
      list: () => [`Which parts in the depot catalog have the word "${word}" in the name? Give all the catalog ids in ascending order, with commas between them (example: P-1001,P-1002).`, namesWith([word]).map((part) => part.id).join(","), Math.ceil(namesWith([word]).length / PAGE_SIZE)],
    }[kind]();
    const taskDir = path.join(dir, name);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.md"), `Use the tools of the MCP server \`depot\` to answer this question.\n\n${question}\n\nWrite only the answer to the file \`answer.txt\` in the current directory. If the depot does not give you the answer, write \`UNKNOWN\`. Do not guess.\n`);
    fs.writeFileSync(path.join(taskDir, "check.sh"), `#!/bin/sh
# exit 0 = pass. On a failure, the partial score comes from the depot call log.
got=$(cat answer.txt 2>/dev/null | tr -d '[:space:]')
if [ "$got" = "${want}" ]; then echo "score: 1"; exit 0; fi
n=$(curl -s "\${QUIRK_URL:-${url}}/admin/cell/$TUNER_CELL" | grep -o '"ok":[0-9][0-9]*' | head -1 | cut -d: -f2)
echo "answer.txt is wrong or missing (got '\${got:-<missing>}'). Successful depot calls: \${n:-0}. The task needs ${need}."
echo "score: $(awk "BEGIN{n=\${n:-0}; if (n > ${need}) n = ${need}; print 0.8*n/${need}}")"
exit 1
`, { mode: 0o755 });
    splits[split].push(name);
  }));
  fs.writeFileSync(path.join(dir, "splits.json"), `${JSON.stringify(splits, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "mcporter.json"), `${JSON.stringify({ mcpServers: { depot: { baseUrl: `${url}/mcp/{{CELL}}` } } }, null, 2)}\n`);
  // The tasks need only the depot and one file write. Without a shell and file reads, an
  // agent cannot read this server's source or call the depot outside its quota.
  const deny = Object.fromEntries(["pi", "agents", "jev", "native", "tasks", "programs", "extensions", "sessions", "memory"].map((provider) => [`${provider}.*`, "deny"]));
  fs.writeFileSync(path.join(dir, "fabric.json"), `${JSON.stringify({ approvals: { actions: { ...deny, "pi.write": "allow", "mcp.$register": "deny" } } }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "SUITE.md"), "Each task asks one question about a parts depot. The agent must call the tools of the MCP server `depot` (search, stock, price, reserve, confirm) and write the answer to `answer.txt`. The depot accepts only its own input formats and gives each task a small quota of calls. A depot call can succeed and still return data that is not the data that the task needs. The questions use different parts, regions, dates, and quantities in each task.\n");
};

const readBody = async (req) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : undefined;
};
const send = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

const serve = async (port) => {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const [, area, name] = url.pathname.split("/");
      if (area === "mcp" && name) {
        // Stateless MCP: one server object for each request. The path names the job (cell).
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        const server = new Server({ name: "depot", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          if (!Object.hasOwn(handlers, request.params.name)) throw new Error(`unknown tool ${request.params.name}`);
          const result = callDepot(name, request.params.name, request.params.arguments);
          return { content: [{ type: "text", text: result.message }], isError: !result.ok };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { void transport.close(); void server.close(); });
        await server.connect(transport);
        return await transport.handleRequest(req, res, await readBody(req));
      }
      if (area === "api" && Object.hasOwn(handlers, `depot_${name}`)) {
        // The plain HTTP backend: the same rules without MCP.
        const { cell = "rest", ...args } = Object.fromEntries(url.searchParams);
        const result = callDepot(cell, `depot_${name}`, args);
        return send(res, result.ok ? 200 : 400, result.ok ? JSON.parse(result.message) : { error: result.message });
      }
      if (area === "admin" && name === "profile") {
        if (req.method === "POST") {
          const body = (await readBody(req)) ?? {};
          if (Number.isInteger(body.seed)) state.profile = makeProfile(body.seed);
          if (Number.isInteger(body.quota) && body.quota > 0) state.quota = body.quota;
        }
        return send(res, 200, describeProfile());
      }
      if (area === "admin" && name === "cell") {
        const stats = cellStats(url.pathname.split("/")[3] ?? "");
        return send(res, 200, { calls: stats.calls, ok: stats.ok, log: stats.log });
      }
      return send(res, 404, { error: "not found" });
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: String(error?.message ?? error) });
    }
  }).listen(port, "127.0.0.1", () => console.log(`quirk depot on http://127.0.0.1:${port} ${JSON.stringify(describeProfile())}`));
};

// Self-check: every active rule passes its own handler, and the natural input fails.
export const demo = () => {
  const throws = (call) => { try { call(); return false; } catch (error) { return error instanceof DepotError; } };
  for (const seed of [1, 2, 3, 4, 5]) {
    const p = makeProfile(seed);
    const stats = cellStats(`demo-${seed}`);
    const wrap = (...words) => `${p.envelope[0]}${words.join(p.join)}${p.envelope[1]}`;
    const number = PARTS.indexOf("steel gasket") + 1001;
    const id = `P-${number}`;
    console.assert(handlers.depot_search({ q: wrap("STEEL", "GASKET") }, p).matches[0].id === id, `search seed ${seed}`);
    const all = namesWith(["steel"]);
    const first = handlers.depot_search({ q: wrap("STEEL") }, p);
    const second = handlers.depot_search({ q: wrap("STEEL"), page: p.page.make(2) }, p);
    console.assert(first.more && first.matches.length === PAGE_SIZE && second.matches[0].id === all[PAGE_SIZE].id, `paging seed ${seed}`);
    console.assert(throws(() => handlers.depot_search({ q: wrap("STEEL"), page: "2" }, p)), `natural page must fail, seed ${seed}`);
    const part = p.part.make(number);
    const stockArgs = { part, region: p.region.make("east"), date: p.date.make(["2026", "03", "14"]) };
    const live = stock(id, "east", "2026-03-14");
    console.assert(handlers.depot_stock({ ...stockArgs, [p.fresh[0]]: p.fresh[1] }, p).units === live, `live stock seed ${seed}`);
    const stale = handlers.depot_stock(stockArgs, p);
    console.assert(stale.snapshot === "STALE" && stale.units !== live, `stale stock seed ${seed}`);
    console.assert(handlers.depot_price({ part, qty: p.qty.make(60), cur: p.cur }, p).total === price(id, 60), `price seed ${seed}`);
    const reserve = () => handlers.depot_reserve({ part, qty: p.qty.make(9), region: p.region.make("east") }, p, stats, `demo-${seed}`).hold;
    const hold = reserve();
    console.assert(handlers.depot_confirm({ hold, pin: p.pin.make(hold.slice(2), 9) }, p, stats).order === orderCode(id, 9, "east"), `order seed ${seed}`);
    const second2 = reserve();
    console.assert(throws(() => handlers.depot_confirm({ hold: second2 }, p, stats)) && throws(() => handlers.depot_confirm({ hold: second2, pin: p.pin.make(second2.slice(2), 9) }, p, stats)), `a wrong pin must void the hold, seed ${seed}`);
    console.assert(throws(() => handlers.depot_search({ q: "steel gasket" }, p)) && throws(() => handlers.depot_stock({ part: id, region: "east", date: "2026-03-14" }, p)), `natural format must fail, seed ${seed}`);
  }
  console.assert(PARTS.length >= 30, `the suite needs 30 parts, the catalog has ${PARTS.length}`);
  console.log(`quirk depot self-check done (${PARTS.length} parts)`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
  const port = Number(arg("port", "4747"));
  if (process.argv.includes("--demo")) demo();
  else if (process.argv.includes("--make-tasks")) makeTasks(arg("make-tasks"), port);
  else if (process.argv.includes("--oracle")) process.stdout.write(oracle(makeProfile(Number(arg("seed", "1")))));
  else {
    state.profile = makeProfile(Number(arg("seed", "1")));
    state.quota = Number(arg("quota", "5"));
    await serve(port);
  }
}
