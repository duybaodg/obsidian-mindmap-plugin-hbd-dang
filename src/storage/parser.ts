import { parseYaml, stringifyYaml } from "obsidian";
import { MindMapConnection, MindMapData, MindMapDocumentViewState, MindMapNode } from "../mindmap/models";

const CURRENT_VERSION = "2.0";
const DEFAULT_VIEW_STATE: MindMapDocumentViewState = {
    zoom: 1,
    pan: { x: 0, y: 0 }
};
const GENERATED_BODY_START = "<!-- mindmap:content:start -->";
const GENERATED_BODY_END = "<!-- mindmap:content:end -->";

export function createEmptyNode(content: string = "Central Topic"): MindMapNode {
    return {
        id: crypto.randomUUID(),
        content,
        children: []
    };
}

export function createEmptyMindMap(): MindMapData {
    return {
        version: CURRENT_VERSION,
        root: createEmptyNode(),
        connections: [],
        view: { ...DEFAULT_VIEW_STATE, pan: { ...DEFAULT_VIEW_STATE.pan } }
    };
}

export function parseMindMap(content: string): MindMapData | null {
    try {
        const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!frontmatterMatch) {
            return null;
        }

        const data = parseYaml(frontmatterMatch[1]);
        if (!data?.mindmap) return null;

        return normalizeMindMap(data.mindmap);
    } catch (e) {
        console.error('Failed to parse mind map:', e);
        return null;
    }
}

function normalizeMindMap(data: any): MindMapData | null {
    if (!data.root) return null;

    return migrateMindMap({
        version: data.version || "1.0",
        root: normalizeNode(data.root),
        connections: normalizeConnections(data.connections),
        view: normalizeViewState(data.view)
    });
}

function migrateMindMap(data: MindMapData): MindMapData {
    if (!data.version || data.version === "1.0") {
        return {
            ...data,
            version: CURRENT_VERSION,
            connections: data.connections ?? [],
            view: data.view ?? { ...DEFAULT_VIEW_STATE, pan: { ...DEFAULT_VIEW_STATE.pan } }
        };
    }

    return {
        ...data,
        version: CURRENT_VERSION,
        connections: data.connections ?? [],
        view: data.view ?? { ...DEFAULT_VIEW_STATE, pan: { ...DEFAULT_VIEW_STATE.pan } }
    };
}

function normalizeNode(node: any): MindMapNode {
    if (Array.isArray(node)) {
        node = node[0] ?? {};
    }

    return {
        id: node.id || crypto.randomUUID(),
        content: node.content || "Untitled",
        note: normalizeOptionalText(node.note),
        linkedFilePath: normalizeOptionalText(node.linkedFilePath),
        children: Array.isArray(node.children)
            ? node.children.map(normalizeNode)
            : [],
        collapsed: node.collapsed === true ? true : undefined,
        position: normalizePosition(node.position)
    };
}

function normalizePosition(position: any): { x: number; y: number } | undefined {
    if (!position || typeof position.x !== "number" || typeof position.y !== "number") {
        return undefined;
    }

    return {
        x: position.x,
        y: position.y
    };
}

function normalizeOptionalText(value: any): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeViewState(view: any): MindMapDocumentViewState | undefined {
    if (!view) return undefined;

    const zoom = typeof view.zoom === "number" ? Math.min(2.5, Math.max(0.4, view.zoom)) : DEFAULT_VIEW_STATE.zoom;
    const pan = normalizePosition(view.pan) ?? DEFAULT_VIEW_STATE.pan;

    return {
        zoom,
        pan: { ...pan }
    };
}

function normalizeConnections(connections: any): MindMapConnection[] {
    if (!Array.isArray(connections)) return [];

    return connections
        .filter((connection) => typeof connection?.fromNodeId === "string" && typeof connection?.toNodeId === "string")
        .map((connection) => ({
            id: typeof connection.id === "string" ? connection.id : crypto.randomUUID(),
            fromNodeId: connection.fromNodeId,
            toNodeId: connection.toNodeId
        }));
}

export function serializeMindMap(data: MindMapData, existingContent?: string): string {
    const yaml = stringifyYaml({ mindmap: data });
    const existingBody = getUserBody(existingContent);
    const generatedBody = renderMindMapMarkdown(data);
    const body = [
        GENERATED_BODY_START,
        generatedBody,
        GENERATED_BODY_END,
        existingBody
    ]
        .filter((part) => part.trim().length > 0)
        .join("\n\n");

    return `---\n${yaml}---\n\n${body}\n`;
}

function getUserBody(existingContent?: string): string {
    if (!existingContent) return "";

    const body = existingContent
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
        .trim();

    return body
        .replace(
            new RegExp(`${escapeRegExp(GENERATED_BODY_START)}[\\s\\S]*?${escapeRegExp(GENERATED_BODY_END)}`, "m"),
            ""
        )
        .trim();
}

function renderMindMapMarkdown(data: MindMapData): string {
    const lines = ["# Mind map", "", ...renderNodeLines(data.root, 0)];
    const connections = data.connections ?? [];

    if (connections.length > 0) {
        lines.push("", "## Connections", "");
        for (const connection of connections) {
            const from = findNodeContent(data.root, connection.fromNodeId);
            const to = findNodeContent(data.root, connection.toNodeId);
            if (from && to) {
                lines.push(`- ${escapeMarkdownText(from)} -> ${escapeMarkdownText(to)}`);
            }
        }
    }

    return lines.join("\n");
}

function renderNodeLines(node: MindMapNode, depth: number): string[] {
    const indent = "  ".repeat(depth);
    const lines = [`${indent}- ${escapeMarkdownText(node.content)}`];
    if (node.note) {
        lines.push(`${indent}  - Note: ${escapeMarkdownText(node.note)}`);
    }
    if (node.linkedFilePath) {
        lines.push(`${indent}  - Linked note: [[${node.linkedFilePath.replace(/\.md$/i, "")}]]`);
    }

    for (const child of node.children) {
        lines.push(...renderNodeLines(child, depth + 1));
    }

    return lines;
}

function escapeMarkdownText(text: string): string {
    return text.replace(/\r?\n/g, " ").trim() || "Untitled";
}

function findNodeContent(node: MindMapNode, nodeId: string): string | null {
    if (node.id === nodeId) return node.content;

    for (const child of node.children) {
        const found = findNodeContent(child, nodeId);
        if (found) return found;
    }

    return null;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
