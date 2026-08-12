import { memo } from 'react';

export interface ApplicationFrameProps {
  readonly started: boolean;
  readonly fatalMessage: string | null;
}

/** Feature hosts never reconcile after nested roots mount into them. */
const FeatureHosts = memo(function FeatureHosts() {
  return (
    <>
      <header className="head" id="headerRoot" />
      <section className="module module-bay" id="controlDeckRoot" />
      <main className="bays">
        <section className="module module-bay bay-soup" id="soupRoot" />
        <section className="module module-bay bay-order" id="orderRoot" />
        <section className="module module-bay bay-tele" id="reactionStateRoot" />
        <div
          className="soup-legends"
          id="soupLegendRoot"
          aria-label="Soup display legends"
        />
        <section className="module module-bay bay-reactor module-tool" id="samplerRoot" />
      </main>
    </>
  );
});

const AuxiliaryHosts = memo(function AuxiliaryHosts() {
  return (
    <>
      <div id="helpRoot" />
      <div id="runsRoot" />
    </>
  );
});

/** React-owned outer application boundary and console geometry. */
export function ApplicationFrame({ started, fatalMessage }: ApplicationFrameProps) {
  return (
    <div id="application" inert={started ? undefined : true}>
      <div id="fitter">
        <div id="consoleStage">
          <div id="console" className="console">
            <div className="edge-light" aria-hidden="true" />
            <div className="alarm" id="alarm" role="alert" hidden={!fatalMessage}>
              <span className="alarm-mark" aria-hidden="true">!</span>
              <span className="alarm-text">
                <b>The simulation core is unavailable.</b>
                <span id="alarmText">{fatalMessage ?? 'Nothing is running.'}</span>
              </span>
            </div>
            <FeatureHosts />
          </div>
        </div>
      </div>
      <AuxiliaryHosts />
    </div>
  );
}
