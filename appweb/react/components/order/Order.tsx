import type { Ref } from 'react';

import type { OrderSummaryViewState } from '../../runtime/viewState.ts';
import { HelpButton } from '../primitives/Button.tsx';
import { ModuleHeader, ModuleTitle, ModuleTools } from '../primitives/Module.tsx';
import { OrderSummary } from './OrderSummary.tsx';

export interface OrderProps {
  readonly canvasRef?: Ref<HTMLCanvasElement>;
  readonly helpPressed: boolean;
  readonly summary: Readonly<OrderSummaryViewState>;
  readonly onHelp: () => void;
}

/** Complete declarative contents of the stable production Order host. */
export function Order({ canvasRef, helpPressed, summary, onHelp }: OrderProps) {
  return (
    <>
      <ModuleHeader>
        <ModuleTitle>population order</ModuleTitle>
        <ModuleTools />
        <HelpButton
          topic="order"
          pressed={helpPressed}
          aria-label="help: population order"
          onClick={onHelp}
        />
      </ModuleHeader>
      <div className="display-shell order-display">
        <div
          className="order-detail"
          id="orderSummaryRoot"
          aria-label="plot legend and current measurement"
        >
          <OrderSummary summary={summary} />
        </div>
        <div className="screen">
          <canvas id="orderCanvas" ref={canvasRef} />
          <div className="scan" aria-hidden="true" />
          <div className="vig" aria-hidden="true" />
        </div>
      </div>
    </>
  );
}
