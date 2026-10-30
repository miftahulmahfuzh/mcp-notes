import { describe, expect, it } from 'vitest';
import { ALL_CONNECTOR_TOOL_NAMES, CONNECTOR_SYSTEMS, CONNECTOR_TOOL_NAMES, schemaToolName, sqlToolName, SYSTEM_META } from '../../../src/connectors/names.js';

describe('connector tool names', () => {
  it('has 15 unique names, five per system, prefixed by the system id', () => {
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(15);
    expect(new Set(ALL_CONNECTOR_TOOL_NAMES).size).toBe(15);
    for (const id of CONNECTOR_SYSTEMS) {
      expect(CONNECTOR_TOOL_NAMES[id]).toHaveLength(5);
      for (const name of CONNECTOR_TOOL_NAMES[id]) expect(name.startsWith(`${id}_`)).toBe(true);
      expect(schemaToolName(id)).toBe(`${id}_schema`);
      expect(sqlToolName(id)).toBe(`${id}_sql`);
    }
    expect(ALL_CONNECTOR_TOOL_NAMES.slice(0, 2)).toEqual(['expenses_schema', 'expenses_sql']);
    expect(ALL_CONNECTOR_TOOL_NAMES.at(-1)).toBe('seer_sera_best');
  });

  it('labels and captions match the contract', () => {
    expect(CONNECTOR_SYSTEMS.map((id) => SYSTEM_META[id].label)).toEqual(['expense-tracking', 'run-insights', 'seer']);
    expect(CONNECTOR_SYSTEMS.map((id) => SYSTEM_META[id].caption)).toEqual(['reading expenses', 'reading runs', 'reading seer']);
    expect(CONNECTOR_SYSTEMS.filter((id) => SYSTEM_META[id].hasLab)).toEqual(['seer']);
  });
});
