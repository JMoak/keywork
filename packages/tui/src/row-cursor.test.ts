import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { RowCursor } from "./row-cursor.ts";

interface Item {
  id: string;
  selectable: boolean;
}

class ItemList extends RowCursor<Item> {
  items: Item[] = [];
  notifications = 0;

  constructor() {
    super(() => {
      this.notifications += 1;
    });
  }

  replace(items: Item[], anchor?: string): void {
    this.mutate(() => {
      this.items = items;
    }, anchor);
  }

  jump(index: number): void {
    this.moveTo(index);
  }

  key(chord: string, pageRows = 3): boolean {
    return this.navigate(parseChord(chord), pageRows);
  }

  protected buildRows(): Item[] {
    return [...this.items];
  }

  protected keyOf(row: Item): string {
    return row.id;
  }

  protected override selectable(row: Item): boolean {
    return row.selectable;
  }
}

function itemsOf(...ids: string[]): Item[] {
  return ids.map((id) => ({ id: id.replace("!", ""), selectable: !id.startsWith("!") }));
}

function listOf(...ids: string[]): ItemList {
  const list = new ItemList();
  list.replace(itemsOf(...ids));
  return list;
}

describe("RowCursor rows and memo", () => {
  it("reuses the built rows until a mutation invalidates them", () => {
    const list = listOf("a", "b");
    const first = list.rows();
    expect(list.rows()).toBe(first);
    list.replace(itemsOf("a", "b", "c"));
    expect(list.rows()).not.toBe(first);
    expect(list.rows()).toHaveLength(3);
  });

  it("cursorRow clamps a stray cursor into the rows", () => {
    const list = listOf("a", "b");
    list.cursor = 9;
    expect(list.cursorRow()?.id).toBe("b");
    expect(new ItemList().cursorRow()).toBeUndefined();
  });
});

describe("RowCursor navigation", () => {
  const cases: { keys: string[]; lands: string }[] = [
    { keys: ["j"], lands: "b" },
    { keys: ["down", "down"], lands: "d" },
    { keys: ["j", "j", "j", "j", "j"], lands: "e" },
    { keys: ["k"], lands: "a" },
    { keys: ["end"], lands: "e" },
    { keys: ["end", "home"], lands: "a" },
    { keys: ["pagedown"], lands: "e" },
    { keys: ["end", "pageup"], lands: "a" },
    { keys: ["j", "j", "pageup"], lands: "a" },
    { keys: ["end", "up"], lands: "d" },
  ];

  it.each(cases)("$keys lands on $lands, paging over selectable rows only", ({ keys, lands }) => {
    const list = listOf("a", "b", "!x", "d", "e");
    for (const key of keys) expect(list.key(key)).toBe(true);
    expect(list.cursorRow()?.id).toBe(lands);
  });

  it("leaves other keys unhandled and the cursor in place", () => {
    const list = listOf("a", "b");
    expect(list.key("x")).toBe(false);
    expect(list.key("enter")).toBe(false);
    expect(list.cursor).toBe(0);
  });

  it("moves nowhere when no row is selectable", () => {
    const list = listOf("!a", "!b");
    expect(list.key("j")).toBe(true);
    expect(list.cursor).toBe(0);
  });
});

describe("RowCursor windowing", () => {
  it("keeps the cursor inside the window and marks only the selectable cursor row", () => {
    const list = listOf("a", "b", "c", "d", "e", "f");
    list.jump(4);
    const window = list.visibleRows(3);
    expect(window.map(({ index }) => index)).toEqual([2, 3, 4]);
    expect(window.map(({ selected }) => selected)).toEqual([false, false, true]);
    list.jump(0);
    expect(list.visibleRows(3).map(({ index }) => index)).toEqual([0, 1, 2]);
  });

  it("never highlights an unselectable row under the cursor", () => {
    const list = listOf("!a", "b");
    list.cursor = 0;
    expect(list.visibleRows(2).map(({ selected }) => selected)).toEqual([false, false]);
  });

  it("selectVisible maps a window offset to the row and reports misses", () => {
    const list = listOf("a", "b", "c", "d");
    list.jump(3);
    list.visibleRows(2);
    expect(list.selectVisible(0, 2)).toBe(true);
    expect(list.cursorRow()?.id).toBe("c");
    expect(list.selectVisible(5, 2)).toBe(false);
  });
});

describe("RowCursor anchoring across mutations", () => {
  it("follows the cursored row by key when the list reorders and grows", () => {
    const list = listOf("a", "b", "c");
    list.jump(1);
    list.replace(itemsOf("z", "c", "b", "a"));
    expect(list.cursorRow()?.id).toBe("b");
  });

  it("clamps to the nearest surviving row when the cursored row vanishes", () => {
    const list = listOf("a", "b", "c");
    list.jump(2);
    list.replace(itemsOf("a"));
    expect(list.cursorRow()?.id).toBe("a");
  });

  it("settles on the first selectable row when the cursor lands on an unselectable one", () => {
    const list = listOf("a", "b", "c");
    list.jump(2);
    list.replace(itemsOf("!h", "x", "!y"));
    expect(list.cursorRow()?.id).toBe("x");
  });

  it("honors an explicit anchor and a cursor set directly before the mutation", () => {
    const list = listOf("a", "b", "c");
    list.replace(itemsOf("a", "b", "c"), "c");
    expect(list.cursorRow()?.id).toBe("c");
    list.cursor = 0;
    list.replace(itemsOf("b", "a", "c"));
    expect(list.cursorRow()?.id).toBe("a");
  });

  it("survives the list emptying and repopulating", () => {
    const list = listOf("a", "b");
    list.jump(1);
    list.replace([]);
    expect(list.cursorRow()).toBeUndefined();
    expect(list.visibleRows(3)).toEqual([]);
    list.replace(itemsOf("solo"));
    expect(list.cursorRow()?.id).toBe("solo");
  });

  it("notifies once per mutation and once per move", () => {
    const list = new ItemList();
    expect(list.notifications).toBe(0);
    list.replace(itemsOf("a", "b"));
    expect(list.notifications).toBe(1);
    list.key("j");
    expect(list.notifications).toBe(2);
  });
});
