# Parallel web search and fetch

[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) provides
web search and page extraction without a Parallel API key. Anonymous access is
free for exploration and light use, with rate limits. This example uses Fabric's
default mcporter connection over Streamable HTTP.

## Configure a project

[Install Pi Fabric](../README.md#install) with Node.js 24+ and Pi 1.0.0+:

```sh
pi install npm:pi-fabric
```

In the project where you run Pi, add this entry to `config/mcporter.json`. Merge
`parallel` into an existing `mcpServers` object to keep your other servers:

```json
{
  "mcpServers": {
    "parallel": {
      "baseUrl": "https://search.parallel.ai/mcp",
      "headers": {
        "User-Agent": "pi-fabric/parallel-search-example"
      }
    }
  }
}
```

No environment variable, authorization header, or OAuth login is needed. Start Pi
in that project, or call `mcp.reload()` inside `fabric_exec` after editing the
configuration. This entry uses mcporter; keep `parallel` out of
`mcp.nativeServers`. See [MCP ownership](configuration.md#opt-in-pi-owned-servers)
if you already manage servers through Pi.

## Search, then read a page

Ask Pi to run this TypeScript program with `fabric_exec` using the default
TypeScript kernel:

```ts
const search = await mcp.parallel.web_search({
  objective: "Find Pi Fabric's MCP configuration documentation.",
  search_queries: ["pi-fabric MCP configuration"],
});
const page = await mcp.parallel.web_fetch({
  urls: ["https://raw.githubusercontent.com/fabric-runtime/pi-fabric/main/docs/configuration.md"],
  objective: "Extract the MCP configuration options.",
});
return { search: search.text, page: page.text };
```

The result contains search excerpts and the fetched page's relevant content.
Replace the query and URL for your task; `web_fetch` accepts up to 20 URLs.
Results retain Fabric's normal `{ text, content, structuredContent }` shape.
Use `tools.describe({ ref: "mcp.parallel.web_search" })` or
`tools.describe({ ref: "mcp.parallel.web_fetch" })` inside `fabric_exec` to inspect
the current input schemas. Calls use the configured `mcp.callTimeoutMs` and
Fabric's existing approval policy.
