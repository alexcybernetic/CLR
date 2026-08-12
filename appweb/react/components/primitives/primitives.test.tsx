import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Button,
  Field,
  HelpButton,
  SegmentedControl,
  Switch,
} from './index.ts';

afterEach(cleanup);

describe('layout primitives', () => {
  it('associates a field caption with its control', () => {
    render(
      <Field caption="engine" labelFor="engine">
        <select id="engine" />
      </Field>,
    );

    expect(screen.getByLabelText('engine').id).toBe('engine');
  });
});

describe('control primitives', () => {
  it('reports segmented choices, including intentional active reselection', () => {
    type Rate = 0 | 10 | 1;
    const onChange = vi.fn<(value: Rate) => void>();

    render(
      <SegmentedControl<Rate>
        ariaLabel="epochs per second"
        allowReselect
        value={0}
        options={[
          { value: 0, label: 'max' },
          { value: 10, label: '10' },
          { value: 1, label: '1' },
        ]}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole('group', { name: 'epochs per second' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'max' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'max' }));
    expect(onChange).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole('button', { name: '10' }));
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it('renders a native switch contract and reports the next state', () => {
    const onCheckedChange = vi.fn<(checked: boolean) => void>();

    render(<Switch checked={false} label="run" scale="lg" onCheckedChange={onCheckedChange} />);

    const control = screen.getByRole('switch', { name: 'run' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('keeps buttons out of implicit form submission and exposes the Help bridge state', () => {
    render(
      <>
        <Button>restart</Button>
        <HelpButton topic="compute" pressed>
          ?
        </HelpButton>
      </>,
    );

    expect(screen.getByRole('button', { name: 'restart' }).getAttribute('type')).toBe('button');
    const help = screen.getByRole('button', { name: 'help: compute' });
    expect(help.classList.contains('btn-hlp')).toBe(true);
    expect(help.getAttribute('aria-pressed')).toBe('true');
    expect(help.getAttribute('data-help')).toBe('compute');
  });
});
