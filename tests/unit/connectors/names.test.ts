import { describe, expect, it } from 'vitest';
import { ALL_CONNECTOR_TOOL_NAMES, CONNECTOR_SYSTEMS, CONNECTOR_TOOL_NAMES, schemaToolName, sqlToolName, SYSTEM_META } from '../../../src/connectors/names.js';

describe('connector tool names', () => {
  it('every name is unique, prefixed by its own system id, with schema/sql first', () => {
    const total = CONNECTOR_SYSTEMS.reduce((sum, id) => sum + CONNECTOR_TOOL_NAMES[id].length, 0);
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(total);
    expect(new Set(ALL_CONNECTOR_TOOL_NAMES).size).toBe(total);
    for (const id of CONNECTOR_SYSTEMS) {
      expect(CONNECTOR_TOOL_NAMES[id].length).toBeGreaterThanOrEqual(2);
      for (const name of CONNECTOR_TOOL_NAMES[id]) expect(name.startsWith(`${id}_`)).toBe(true);
      expect(CONNECTOR_TOOL_NAMES[id][0]).toBe(`${id}_schema`);
      expect(CONNECTOR_TOOL_NAMES[id][1]).toBe(`${id}_sql`);
      expect(schemaToolName(id)).toBe(`${id}_schema`);
      expect(sqlToolName(id)).toBe(`${id}_sql`);
    }
    expect(ALL_CONNECTOR_TOOL_NAMES.slice(0, 2)).toEqual(['expenses_schema', 'expenses_sql']);
  });

  it('labels and captions match the contract', () => {
    expect(CONNECTOR_SYSTEMS.map((id) => SYSTEM_META[id].label)).toEqual(['expense-tracking', 'run-insights', 'seer', 'daily-words']);
    expect(CONNECTOR_SYSTEMS.map((id) => SYSTEM_META[id].caption)).toEqual(['reading expenses', 'reading runs', 'reading seer', 'reading daily-words']);
    expect(CONNECTOR_SYSTEMS.filter((id) => SYSTEM_META[id].hasLab)).toEqual(['seer']);
  });
});
