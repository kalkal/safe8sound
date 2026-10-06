import { describe, expect, it } from 'vitest';
import { applyChange, badgeText, scriptedDemoSettings, skyOfScenario } from '../../src/ui/demo-settings.js';

// B1 (additions plan): what the scenario badge says and how a choice changes the settings shown, in scripted mode.

describe('demo settings', () => {
  it('starts on the heat-wave day at the reference home, in °C, with an older man at home', () => {
    expect(scriptedDemoSettings()).toMatchObject({ scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man', placeLabel: 'Reference home (central Italy)' });
  });

  it('the badge names the place and the scenario; in the storm it says the power is out', () => {
    expect(badgeText(scriptedDemoSettings())).toBe('SCENARIO · Reference home (central Italy) · Heat wave');
    expect(badgeText({ ...scriptedDemoSettings(), scenarioId: 'storm-blackout' })).toBe('SCENARIO · Reference home (central Italy) · Storm · power outage');
  });

  it('a choice changes only what was chosen; a restart changes nothing but the day', () => {
    const before = scriptedDemoSettings();
    expect(applyChange(before, { units: 'F' })).toEqual({ ...before, units: 'F' });
    expect(applyChange(before, { restart: true })).toEqual(before);
  });

  it('each scenario has its sky', () => {
    expect(skyOfScenario('clear-day')).toBe('mild');
    expect(skyOfScenario('heatwave')).toBe('hot');
    expect(skyOfScenario('storm-blackout')).toBe('storm');
  });
});
