// src/services/ai/tool-exposure.test.ts
// Hybrid / lazy tool catalog (#203 step B): what each mode exposes, the index text, discovery
// and the rejection of a tool called before its schema was loaded.

import { describe, expect, it } from 'bun:test';
import {
  buildToolIndex,
  createToolExposure,
  DISCOVERY_TOOL,
  HYBRID_CORE_TOOLS,
  TOOL_INDEX_LINES,
} from './tool-exposure';
import { TOOL_DEFINITIONS } from './tools';

type Tool = (typeof TOOL_DEFINITIONS)[number];
const nameOf = (tool: Tool): string => (tool.type === 'function' ? tool.function.name : tool.type);
const ALL_NAMES = TOOL_DEFINITIONS.map(nameOf);

describe('catalog metadata', () => {
  it('has an index line for every tool and none for a tool that does not exist', () => {
    expect(Object.keys(TOOL_INDEX_LINES).sort()).toEqual([...ALL_NAMES].sort());
  });

  it('keeps the hybrid core to real tools without duplicates', () => {
    expect(new Set(HYBRID_CORE_TOOLS).size).toBe(HYBRID_CORE_TOOLS.length);
    for (const name of HYBRID_CORE_TOOLS) expect(ALL_NAMES).toContain(name);
  });
});

describe('buildToolIndex', () => {
  it('is empty in full mode', () => {
    expect(buildToolIndex('full')).toBe('');
  });

  it('lists exactly the non-core tools in hybrid mode, in catalog order, and names discover_tools', () => {
    const index = buildToolIndex('hybrid');
    const listed = index
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2, line.indexOf(':')));
    expect(listed).toEqual(ALL_NAMES.filter((name) => !HYBRID_CORE_TOOLS.includes(name)));
    expect(index).toContain(DISCOVERY_TOOL);
    expect(index.startsWith('## TOOL INDEX')).toBe(true);
  });

  it('lists everything but calculate in lazy mode', () => {
    const listed = buildToolIndex('lazy')
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2, line.indexOf(':')));
    expect(listed).toEqual(ALL_NAMES.filter((name) => name !== 'calculate'));
  });

  it('is byte-identical on every call (it sits in the cacheable prefix)', () => {
    expect(buildToolIndex('hybrid')).toBe(buildToolIndex('hybrid'));
  });
});

describe('createToolExposure', () => {
  it('full mode: every schema, no discovery tool, no rejection', () => {
    const exposure = createToolExposure('full');
    expect(exposure.tools().map(nameOf)).toEqual(ALL_NAMES);
    expect(exposure.isDiscovery(DISCOVERY_TOOL)).toBe(false);
    expect(exposure.rejectUnexposedCall('update_group_setting')).toBeNull();
  });

  it('hybrid mode: discover_tools first, then the core in its fixed order', () => {
    expect(createToolExposure('hybrid').tools().map(nameOf)).toEqual([
      DISCOVERY_TOOL,
      ...HYBRID_CORE_TOOLS,
    ]);
  });

  it('lazy mode: discover_tools and calculate only', () => {
    expect(createToolExposure('lazy').tools().map(nameOf)).toEqual([DISCOVERY_TOOL, 'calculate']);
  });

  it('is smaller than the full catalog in hybrid mode (the point of the mode)', () => {
    const full = JSON.stringify(createToolExposure('full').tools()).length;
    const hybrid = JSON.stringify(createToolExposure('hybrid').tools()).length;
    expect(hybrid).toBeLessThan(full * 0.6);
  });

  it('discover reveals the named tools after the always-on ones, in reveal order, once the round ends', () => {
    const exposure = createToolExposure('hybrid');
    const result = exposure.discover({ tools: ['update_group_setting', 'get_categories'] });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Loaded: update_group_setting, get_categories');
    expect(exposure.tools().map(nameOf)).toEqual([DISCOVERY_TOOL, ...HYBRID_CORE_TOOLS]);
    exposure.endRound();
    expect(exposure.tools().map(nameOf)).toEqual([
      DISCOVERY_TOOL,
      ...HYBRID_CORE_TOOLS,
      'update_group_setting',
      'get_categories',
    ]);
  });

  it('discover reports tools that are already loaded or not in the catalog, revealing nothing for them', () => {
    const exposure = createToolExposure('hybrid');
    const result = exposure.discover({ tools: ['get_expenses', 'no_such_tool'] });
    expect(result.output).toContain('Already loaded: get_expenses');
    expect(result.output).toContain('Not in the index: no_such_tool');
    expect(exposure.tools().map(nameOf)).toEqual([DISCOVERY_TOOL, ...HYBRID_CORE_TOOLS]);
  });

  it('discover fails when nothing it names exists', () => {
    const result = createToolExposure('hybrid').discover({ tools: ['no_such_tool'] });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Not in the index: no_such_tool');
  });

  it.each([
    {},
    { tools: 'get_categories' },
    { tools: [] },
    { tools: [1] },
    { tools: Array.from({ length: 25 }, () => 'get_categories') },
  ])('discover rejects malformed input %p', (input) => {
    const result = createToolExposure('hybrid').discover(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain(DISCOVERY_TOOL);
  });

  it('discover stops after six calls in one run', () => {
    const exposure = createToolExposure('hybrid');
    for (let i = 0; i < 6; i++)
      expect(exposure.discover({ tools: ['get_categories'] }).success).toBe(true);
    const seventh = exposure.discover({ tools: ['get_categories'] });
    expect(seventh.success).toBe(false);
    expect(seventh.error).toContain('limit reached');
  });

  it('isDiscovery is true only for discover_tools outside full mode', () => {
    const exposure = createToolExposure('hybrid');
    expect(exposure.isDiscovery(DISCOVERY_TOOL)).toBe(true);
    expect(exposure.isDiscovery('get_expenses')).toBe(false);
  });

  it('rejects a known tool that was never loaded, loads it for the next round, and then lets the next call through', () => {
    const exposure = createToolExposure('hybrid');
    const rejected = exposure.rejectUnexposedCall('update_group_setting');
    expect(rejected?.success).toBe(false);
    expect(rejected?.error).toContain('TOOL_SCHEMA_NOT_EXPOSED');
    expect(rejected?.error).toContain('NOT run');
    expect(exposure.tools().map(nameOf)).not.toContain('update_group_setting');
    exposure.endRound();
    expect(exposure.tools().map(nameOf)).toContain('update_group_setting');
    expect(exposure.rejectUnexposedCall('update_group_setting')).toBeNull();
  });

  it('a tool loaded by discover in a round is still rejected for the rest of that round', () => {
    const exposure = createToolExposure('hybrid');
    exposure.discover({ tools: ['update_group_setting'] });
    expect(exposure.rejectUnexposedCall('update_group_setting')?.success).toBe(false);
    expect(exposure.rejectUnexposedCall('update_group_setting')?.success).toBe(false);
  });

  it('lets core tools and unknown names take the normal execution path', () => {
    const exposure = createToolExposure('hybrid');
    expect(exposure.rejectUnexposedCall('get_expenses')).toBeNull();
    expect(exposure.rejectUnexposedCall('no_such_tool')).toBeNull();
  });

  it('keeps run state per exposure: a new exposure starts from the core again', () => {
    const first = createToolExposure('hybrid');
    first.discover({ tools: ['get_categories'] });
    expect(createToolExposure('hybrid').tools().map(nameOf)).not.toContain('get_categories');
  });
});
