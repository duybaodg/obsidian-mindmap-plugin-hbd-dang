import { MindMapNode } from "./models";

const CONFIG = {
    NODE_WIDTH: 120,
    NODE_HEIGHT: 40,
    HORIZONTAL_SPACING: 40,
    VERTICAL_SPACING: 30
};

export interface LayoutPosition {
    x: number;
    y: number;
}

export function layoutTree(root: MindMapNode): Map<string, LayoutPosition> {
    const positions = new Map<string, LayoutPosition>();
    const depths = new Map<MindMapNode, number>();

    function calculateDepth(node: MindMapNode, depth: number = 0): void {
        depths.set(node, depth);
        if (node.collapsed) return;

        for (const child of node.children) {
            calculateDepth(child, depth + 1);
        }
    }
    calculateDepth(root);

    const depthNodes = new Map<number, MindMapNode[]>();
    for (const [node, depth] of depths) {
        if (!depthNodes.has(depth)) {
            depthNodes.set(depth, []);
        }
        depthNodes.get(depth)!.push(node);
    }

    for (const [depth, nodes] of depthNodes) {
        const y = depth * (CONFIG.NODE_HEIGHT + CONFIG.VERTICAL_SPACING);
        for (const node of nodes) {
            const existing = positions.get(node.id);
            positions.set(node.id, { x: existing?.x ?? 0, y });
        }
    }

    // Track the last X position at each depth for sibling spacing
    const lastXAtDepth = new Map<number, number>();

    function calculateX(node: MindMapNode): number {
        const visibleChildren = node.collapsed ? [] : node.children;

        if (visibleChildren.length === 0) {
            const yPos = positions.get(node.id)!.y;
            const depth = depths.get(node)!;

            const lastX = lastXAtDepth.get(depth) ?? 0;
            const newX = lastX + CONFIG.NODE_WIDTH + CONFIG.HORIZONTAL_SPACING;

            positions.set(node.id, { x: newX, y: yPos });
            lastXAtDepth.set(depth, newX);

            return newX;
        }

        let firstChildX: number | null = null;
        let lastChildX: number | null = null;

        for (const child of visibleChildren) {
            const childX = calculateX(child);
            if (firstChildX === null) firstChildX = childX;
            lastChildX = childX;
        }

        const center = (firstChildX! + lastChildX!) / 2;
        const yPos = positions.get(node.id)!.y;
        positions.set(node.id, { x: center, y: yPos });

        return center;
    }

    calculateX(root);

    const rootPos = positions.get(root.id)!;
    const offsetX = -rootPos.x;

    for (const [id, pos] of positions) {
        positions.set(id, { x: pos.x + offsetX, y: pos.y });
    }

    return positions;
}
