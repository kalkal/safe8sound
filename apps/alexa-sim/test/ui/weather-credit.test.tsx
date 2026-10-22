// @vitest-environment jsdom
import { ok, type LocationId } from '@cold-reserve/contracts';
import { setLocale } from '@cold-reserve/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from '../../src/agent/agent.js';
import { parseConfig } from '../../src/config.js';
import { Conversation } from '../../src/ui/Conversation.js';

afterEach(() => {
  cleanup();
  setLocale('en-US');
});

// Open-Meteo's licence (CC BY 4.0): "a link next to any location Open-Meteo data are displayed". The Echo's top bar shows the
// place and its weather, so the line under the device credits it too (owner, 22 Oct), only for the places whose weather it
// gives (Turin, Houston); the reference home's weather is our own.

const config = parseConfig({ VITE_SPEAK_REPLIES: 'false' }, '?voice=fake', true);
if (!config.ok) throw new Error('config');
const agent: Agent = { canCallTools: true, ask: () => Promise.resolve(ok({ text: 'ok' })), callTool: () => Promise.reject(new Error('unused')) };

function show(place: LocationId | undefined) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Conversation agent={agent} turnBudgetMs={5_000} timeZone="Europe/Rome" voice={config.ok ? config.value.voice : (undefined as never)} {...(place === undefined ? {} : { place })} />
    </QueryClientProvider>,
  );
}

describe('the Open-Meteo credit under the device (owner, 22 Oct)', () => {
  it('Turin and Houston: a link to open-meteo.com in the notes under the device, in both languages', () => {
    for (const place of ['turin', 'houston'] as const) {
      show(place);
      const link = screen.getByRole('link', { name: 'Weather data by Open-Meteo.com (CC BY 4.0)' });
      expect(link.getAttribute('href')).toBe('https://open-meteo.com/');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.closest('.ask-bar-notes')).not.toBeNull();
      cleanup();
    }
    setLocale('it-IT');
    show('turin');
    expect(screen.getByRole('link', { name: 'Dati meteo di Open-Meteo.com (CC BY 4.0)' })).toBeTruthy();
  });

  it('the reference home, or no place known: none', () => {
    show('reference');
    expect(screen.queryByRole('link', { name: /Open-Meteo/ })).toBeNull();
    cleanup();
    show(undefined);
    expect(screen.queryByRole('link', { name: /Open-Meteo/ })).toBeNull();
  });
});
