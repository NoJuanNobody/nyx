import { describe, it, expect } from 'vitest';
import {
  allExpandableIds,
  buildFolderTree,
  buildStageTree,
  findTypeahead,
  flattenVisible,
  folderId,
  isDocId,
  visibleRange,
  type ExplorerDoc,
} from '../../lib/explorerTree';

const doc = (id: string, title: string, path = '/', stage: string | null = null): ExplorerDoc => ({
  id,
  title,
  path,
  stage,
});

describe('buildFolderTree', () => {
  it('puts folders before documents and sorts case-insensitively', () => {
    const tree = buildFolderTree(
      [doc('1', 'zeta'), doc('2', 'Alpha doc'), doc('3', 'in b', '/b')],
      ['/beta', '/Alpha', '/b'],
    );
    expect(tree.map((n) => n.label)).toEqual(['Alpha', 'b', 'beta', 'Alpha doc', 'zeta']);
    expect(tree.find((n) => n.label === 'b')?.children.map((c) => c.label)).toEqual(['in b']);
  });

  it('keeps empty folders and creates missing ancestors', () => {
    const tree = buildFolderTree([], ['/a/b/c']);
    expect(tree[0].label).toBe('a');
    expect(tree[0].children[0].children[0].path).toBe('/a/b/c');
  });

  it('places documents with missing or trailing-slash paths correctly', () => {
    const tree = buildFolderTree([doc('1', 'root', ''), doc('2', 'x', '/f/')], []);
    expect(tree.map((n) => n.label)).toEqual(['f', 'root']);
  });
});

describe('buildStageTree', () => {
  const stages = [
    { id: 'concept', label: 'Concept' },
    { id: 'build', label: 'Build' },
  ];

  it('keeps pipeline order and keeps empty stages as drop targets', () => {
    const tree = buildStageTree([doc('1', 'a', '/', 'build')], stages);
    expect(tree.map((n) => n.label)).toEqual(['Concept', 'Build']);
    expect(tree[0].children).toHaveLength(0);
    expect(tree[1].children.map((c) => c.label)).toEqual(['a']);
  });

  it('collects unstaged and foreign-stage docs under a trailing No stage group', () => {
    const tree = buildStageTree(
      [doc('1', 'none'), doc('2', 'foreign', '/', 'other-pipeline')],
      stages,
    );
    const last = tree[tree.length - 1];
    expect(last.label).toBe('No stage');
    expect(last.children.map((c) => c.label)).toEqual(['foreign', 'none']);
  });

  it('omits the No stage group when empty', () => {
    expect(buildStageTree([doc('1', 'a', '/', 'build')], stages)).toHaveLength(2);
  });
});

describe('flattenVisible', () => {
  const tree = buildFolderTree([doc('1', 'd1', '/a'), doc('2', 'd2', '/a/b'), doc('3', 'd3', '/z')], []);

  it('only descends into expanded folders and reports aria metadata', () => {
    const closed = flattenVisible(tree, new Set());
    expect(closed.map((r) => r.node.label)).toEqual(['a', 'z']);
    expect(closed[0]).toMatchObject({ level: 1, posInSet: 1, setSize: 2, expandable: true, expanded: false });

    const open = flattenVisible(tree, new Set([folderId('/a'), folderId('/a/b')]));
    expect(open.map((r) => `${r.level}:${r.node.label}`)).toEqual([
      '1:a',
      '2:b',
      '3:d2',
      '2:d1',
      '1:z',
    ]);
    const d1 = open.find((r) => r.node.label === 'd1')!;
    expect(d1).toMatchObject({ expandable: false, setSize: 2, posInSet: 2, parentId: folderId('/a') });
  });

  it('lists expandable ids', () => {
    expect(allExpandableIds(tree)).toEqual([folderId('/a'), folderId('/a/b'), folderId('/z')]);
    expect(isDocId('doc:1')).toBe(true);
    expect(isDocId('folder:/a')).toBe(false);
  });
});

describe('visibleRange', () => {
  it('windows rows with overscan and clamps', () => {
    expect(visibleRange(0, 280, 28, 10_000, 5)).toEqual({ start: 0, end: 15 });
    expect(visibleRange(2800, 280, 28, 10_000, 5)).toEqual({ start: 95, end: 115 });
    expect(visibleRange(999_999, 280, 28, 100, 5)).toEqual({ start: 94, end: 100 });
    expect(visibleRange(-50, 100, 20, 3)).toEqual({ start: 0, end: 3 });
  });
});

describe('findTypeahead', () => {
  const rows = flattenVisible(
    buildFolderTree([doc('1', 'Apple'), doc('2', 'avocado'), doc('3', 'Banana')], []),
    new Set(),
  );
  it('finds by prefix, case-insensitively', () => {
    expect(findTypeahead(rows, 0, 'ban')).toBe(2);
    expect(findTypeahead(rows, 0, 'zzz')).toBe(-1);
  });
  it('cycles on a repeated letter', () => {
    expect(findTypeahead(rows, 0, 'a')).toBe(1);
    expect(findTypeahead(rows, 1, 'a')).toBe(0);
  });
});
