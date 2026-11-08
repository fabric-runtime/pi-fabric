import type { Component } from "@earendil-works/pi-tui";
import { truncateStyledText as truncateToWidth } from "./truncate.js";

interface MeasuredPartialResult {
  component: Component;
  width: number;
  rows: number;
}

export interface ResultRowBalance {
  partial?: MeasuredPartialResult;
  final?: Component;
  finalized?: boolean;
}

export type LimitRenderer = (limit: number, width: number) => string[];

export class HiddenRowBorrowingComponent implements Component {
  #cachedWidth: number | undefined;
  #cachedDeficit: number | undefined;
  #cachedRows: string[] | undefined;

  constructor(
    private readonly baseLimit: number,
    private readonly maxLimit: number,
    private readonly renderLimit: LimitRenderer,
    private readonly balance: ResultRowBalance,
  ) {}

  render(width: number): string[] {
    const deficit = resultRowDeficit(this.balance, width);
    if (
      this.#cachedWidth === width &&
      this.#cachedDeficit === deficit &&
      this.#cachedRows
    ) {
      return this.#cachedRows;
    }

    const base = this.renderLimit(this.baseLimit, width);
    let best = base;
    if (deficit > 0 && this.maxLimit > this.baseLimit) {
      let bestGrowth = 0;
      for (let limit = this.baseLimit + 1; limit <= this.maxLimit; limit++) {
        const candidate = this.renderLimit(limit, width);
        const growth = candidate.length - base.length;
        if (growth > deficit) break;
        if (growth >= bestGrowth) {
          best = candidate;
          bestGrowth = growth;
        }
      }
    }
    // Upstream components (pi's Text wrap) can overproduce at tiny widths;
    // never emit a row wider than the requested width (issue #84).
    this.#cachedWidth = width;
    this.#cachedDeficit = deficit;
    this.#cachedRows = best.map((row) => truncateToWidth(row, Math.max(1, width)));
    return this.#cachedRows;
  }

  invalidate(): void {
    this.#cachedWidth = undefined;
    this.#cachedDeficit = undefined;
    this.#cachedRows = undefined;
  }
}

export const observeResultRows = (
  component: Component,
  balance: ResultRowBalance,
  options: { expanded: boolean; isPartial: boolean },
): Component => {
  if (options.isPartial) {
    balance.finalized = false;
    delete balance.final;
    return options.expanded ? component : new PartialResultObserver(component, balance);
  }

  balance.finalized = true;
  if (options.expanded) delete balance.final;
  else balance.final = component;
  return component;
};

export const resultRowDeficit = (
  balance: ResultRowBalance,
  width: number,
): number => {
  if (!balance.finalized || !balance.partial || !balance.final) return 0;
  const partialRows = balance.partial.width === width
    ? balance.partial.rows
    : balance.partial.component.render(width).length;
  const finalRows = balance.final.render(width).length;
  return Math.max(0, partialRows - finalRows);
};

class PartialResultObserver implements Component {
  constructor(
    private readonly component: Component,
    private readonly balance: ResultRowBalance,
  ) {}

  render(width: number): string[] {
    const lines = this.component.render(width);
    const previous = this.balance.partial;
    if (
      !previous ||
      previous.width !== width ||
      lines.length >= previous.rows
    ) {
      this.balance.partial = {
        component: this.component,
        width,
        rows: lines.length,
      };
    }
    return lines;
  }

  invalidate(): void {
    this.component.invalidate?.();
  }
}
