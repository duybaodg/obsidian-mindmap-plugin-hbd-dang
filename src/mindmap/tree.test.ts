import { test } from "node:test";
import * as assert from "node:assert/strict";
import { MindMapData } from "./models";
import {
    addChildNode,
    cloneMindMap,
    deleteNode,
    findNode,
    groupSiblingNodes,
    renameNode,
    reparentNode,
    toggleCollapse
} from "./tree";

function fixture(): MindMapData {
    return {
        version: "2.0",
        root: {
            id: "root",
            content: "Root",
            children: [
                { id: "a", content: "A", children: [] },
                { id: "b", content: "B", children: [] }
            ]
        },
        view: { zoom: 1, pan: { x: 0, y: 0 } }
    };
}

test("renames, adds, toggles and deletes nodes", () => {
    const data = fixture();

    assert.equal(renameNode(data.root, "a", "Alpha"), true);
    assert.equal(findNode(data.root, "a")?.content, "Alpha");

    assert.equal(addChildNode(data.root, "a", { id: "c", content: "C", children: [] }), true);
    assert.equal(findNode(data.root, "c")?.content, "C");

    assert.equal(toggleCollapse(data.root, "a"), true);
    assert.equal(findNode(data.root, "a")?.collapsed, true);

    assert.equal(deleteNode(data.root, "c")?.id, "c");
    assert.equal(findNode(data.root, "c"), null);
});

test("reparents nodes without allowing cycles", () => {
    const data = fixture();
    addChildNode(data.root, "a", { id: "c", content: "C", children: [] });

    assert.equal(reparentNode(data.root, "c", "b", { x: 10, y: 20 }), true);
    assert.equal(findNode(data.root, "b")?.children[0].id, "c");

    assert.equal(reparentNode(data.root, "b", "c", { x: 0, y: 0 }), false);
});

test("groups sibling nodes into one parent node", () => {
    const data = fixture();
    const group = groupSiblingNodes(data.root, ["a", "b"], "D", { x: 4, y: 5 });

    assert.equal(group?.content, "D");
    assert.deepEqual(data.root.children.map((node) => node.content), ["D"]);
    assert.deepEqual(group?.children.map((node) => node.id), ["a", "b"]);
});

test("clones mind maps without sharing nested objects", () => {
    const data = fixture();
    const cloned = cloneMindMap(data);

    cloned.root.children[0].content = "Changed";
    assert.equal(data.root.children[0].content, "A");
});
