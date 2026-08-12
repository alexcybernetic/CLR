import type { OrderSummaryViewState } from '../../runtime/viewState.ts';

export interface OrderSummaryProps {
  readonly summary: Readonly<OrderSummaryViewState>;
}

function metric(value: number | null): string {
  return value === null ? '—' : value.toFixed(3);
}

/** Current scalar measurement beside the imperative population-order plot. */
export function OrderSummary({ summary }: OrderSummaryProps) {
  return (
    <>
      <span className="order-stat">
        <b>measurement epoch</b>
        <output id="orderEpoch">
          {summary.epoch === null ? '—' : String(Math.round(summary.epoch))}
        </output>
      </span>
      <span className="order-stat key-a">
        high-order entropy <output id="orderHigh">{metric(summary.highOrder)}</output>
      </span>
      <span className="order-stat key-b">
        byte-frequency order{' '}
        <output id="orderByte">{metric(summary.byteFrequencyOrder)}</output>
      </span>
      <span className="order-stat">
        <b>H₀</b>
        <output id="orderH0">{metric(summary.zeroOrderEntropy)}</output>
      </span>
      <span className="order-stat key-c">
        compressed bits/byte{' '}
        <output id="orderCompressed">{metric(summary.compressedBitsPerByte)}</output>
      </span>
    </>
  );
}
