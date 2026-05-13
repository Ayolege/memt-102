export interface MomentumParams {
  lookbackSamples: number;
  breakoutThreshold: number;
  trailingStop: number;
  hardStop: number;
  takeProfit: number;
}

export interface PositionSnapshot {
  entryPrice: number;
  highWaterPrice: number;
}

const SHORT_PERIOD = 5;
const LONG_PERIOD = 20;

export const ema = (prev: number | null, value: number, period: number): number => {
  const k = 2 / (period + 1);
  return prev === null ? value : value * k + prev * (1 - k);
};

export class WatchedToken {
  prices: number[] = [];
  shortEma: number | null = null;
  longEma: number | null = null;

  constructor(
    public readonly mint: string,
    public readonly params: MomentumParams,
  ) {}

  observe(price: number) {
    this.prices.push(price);
    if (this.prices.length > this.params.lookbackSamples) this.prices.shift();
    this.shortEma = ema(this.shortEma, price, SHORT_PERIOD);
    this.longEma = ema(this.longEma, price, LONG_PERIOD);
  }

  shouldEnter(): boolean {
    if (this.prices.length < this.params.lookbackSamples) return false;
    if (this.shortEma === null || this.longEma === null) return false;
    if (this.shortEma <= this.longEma) return false;
    const current = this.prices[this.prices.length - 1]!;
    const high = Math.max(...this.prices.slice(0, -1));
    return current > high * (1 + this.params.breakoutThreshold);
  }
}

export function exitReason(
  pos: PositionSnapshot,
  currentPrice: number,
  params: MomentumParams,
): string | null {
  const drawdown = 1 - currentPrice / pos.highWaterPrice;
  if (drawdown >= params.trailingStop) return `trailing stop (${(drawdown * 100).toFixed(1)}%)`;

  const totalLoss = 1 - currentPrice / pos.entryPrice;
  if (totalLoss >= params.hardStop) return `hard stop (${(totalLoss * 100).toFixed(1)}%)`;

  if (params.takeProfit > 0) {
    const gain = currentPrice / pos.entryPrice - 1;
    if (gain >= params.takeProfit) return `take profit (${(gain * 100).toFixed(1)}%)`;
  }
  return null;
}
