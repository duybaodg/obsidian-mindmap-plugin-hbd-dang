import { MindMapData, MindMapNode } from "./models";
import { LayoutPosition } from "./layout";

export function cloneMindMap(data: MindMapData): MindMapData {
    return JSON.parse(JSON.stringify(data)) as MindMapData;
}

export function createNode(content = "New node", position?: LayoutPosition): MindMapNode {
    return {
        id: crypto.randomUUID(),
        content,
        children: [],
        position
    };
}

export function findNode(node: MindMapNode, id: string): MindMapNode | null {
    if (node.id === id) return node;

    for (const child of node.children) {
        const found = findNode(child, id);
        if (found) return found;
    }

    return null;
}

export function findParent(node: MindMapNode, childId: string): MindMapNode | null {
    for (const child of node.children) {
        if (child.id === childId) return node;

        const found = findParent(child, childId);
        if (found) return found;
    }

    return null;
}

export function findChildRef(
    root: MindMapNode,
    nodeId: string
): { parent: MindMapNode; index: number } | null {
    for (let index = 0; index < root.children.length; index++) {
        const child = root.children[index];
        if (child.id === nodeId) {
            return { parent: root, index };
        }

        const found = findChildRef(child, nodeId);
        if (found) return found;
    }

    return null;
}

export function addChildNode(root: MindMapNode, parentNodeId: string, node: MindMapNode): boolean {
    const parent = findNode(root, parentNodeId);
    if (!parent) return false;

    parent.children.push(node);
    return true;
}

export function addSiblingNode(root: MindMapNode, siblingNodeId: string, node: MindMapNode): boolean {
    const parent = findParent(root, siblingNodeId);
    if (!parent) return false;

    parent.children.push(node);
    return true;
}

export function renameNode(root: MindMapNode, nodeId: string, content: string): boolean {
    const node = findNode(root, nodeId);
    const trimmed = content.trim();
    if (!node || !trimmed) return false;

    node.content = trimmed;
    return true;
}

export function moveNode(root: MindMapNode, nodeId: string, position: LayoutPosition): boolean {
    const node = findNode(root, nodeId);
    if (!node) return false;

    node.position = position;
    return true;
}

export function toggleCollapse(root: MindMapNode, nodeId: string): boolean {
    const node = findNode(root, nodeId);
    if (!node || node.children.length === 0) return false;

    node.collapsed = !node.collapsed;
    return true;
}

export function deleteNode(root: MindMapNode, nodeId: string): MindMapNode | null {
    const ref = findChildRef(root, nodeId);
    if (!ref) return null;

    const [removed] = ref.parent.children.splice(ref.index, 1);
    return removed ?? null;
}

export function reparentNode(
    root: MindMapNode,
    nodeId: string,
    targetNodeId: string,
    position: LayoutPosition
): boolean {
    if (nodeId === targetNodeId || isDescendant(root, nodeId, targetNodeId)) return false;

    const target = findNode(root, targetNodeId);
    if (!target) return false;

    const node = deleteNode(root, nodeId);
    if (!node) return false;

    node.position = position;
    target.children.push(node);
    return true;
}

export function groupSiblingNodes(
    root: MindMapNode,
    nodeIds: string[],
    groupContent: string,
    position?: LayoutPosition
): MindMapNode | null {
    const refs = nodeIds
        .map((id) => ({ id, ref: findChildRef(root, id) }))
        .filter((entry): entry is { id: string; ref: { parent: MindMapNode; index: number } } => entry.ref !== null);
    if (refs.length < 2) return null;

    const parent = refs[0].ref.parent;
    if (!refs.every((entry) => entry.ref.parent === parent)) return null;

    const orderedRefs = refs.sort((a, b) => a.ref.index - b.ref.index);
    const orderedNodes = orderedRefs.map((entry) => parent.children[entry.ref.index]);
    const indices = orderedRefs.map((entry) => entry.ref.index).sort((a, b) => b - a);

    for (const index of indices) {
        parent.children.splice(index, 1);
    }

    const groupNode: MindMapNode = {
        id: crypto.randomUUID(),
        content: groupContent.trim() || orderedNodes.map((node) => node.content).join(" + "),
        children: orderedNodes,
        collapsed: false,
        position
    };
    groupNode.children.forEach((node) => delete node.position);
    parent.children.splice(Math.min(...indices), 0, groupNode);

    return groupNode;
}

export function isDescendant(root: MindMapNode, nodeId: string, possibleDescendantId: string): boolean {
    const node = findNode(root, nodeId);
    return node ? findNode(node, possibleDescendantId) !== null && node.id !== possibleDescendantId : false;
}

export function clearPositions(node: MindMapNode): void {
    delete node.position;
    node.children.forEach(clearPositions);
}

export function getGroupPosition(firstNode: MindMapNode, secondNode: MindMapNode): LayoutPosition | undefined {
    if (!firstNode.position || !secondNode.position) return firstNode.position ?? secondNode.position;

    return {
        x: (firstNode.position.x + secondNode.position.x) / 2,
        y: Math.min(firstNode.position.y, secondNode.position.y)
    };
}
