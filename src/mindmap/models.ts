/**
 * Represents a single node in the mind map
 */
export interface MindMapNode {
    /** Unique identifier for this node */
    id: string;
    /** User-entered text content */
    content: string;
    /** Longer node detail stored inside the mind map file */
    note?: string;
    /** Optional linked Obsidian note path */
    linkedFilePath?: string;
    /** Child nodes of this node */
    children: MindMapNode[];
    /** UI state: whether children are hidden */
    collapsed?: boolean;
    /** Calculated position from layout engine (not persisted) */
    position?: { x: number; y: number };
}

export interface MindMapConnection {
    id: string;
    fromNodeId: string;
    toNodeId: string;
}

/**
 * Root data structure for a mind map document
 */
export interface MindMapData {
    /** The root/central node of the mind map */
    root: MindMapNode;
    /** Data format version for migration support */
    version: string;
    /** Persisted viewport state, stored separately from node/tree data */
    view?: MindMapDocumentViewState;
    /** Extra graph links between nodes, separate from the parent/child tree */
    connections?: MindMapConnection[];
}

/**
 * UI state for the mind map view
 */
export interface MindMapViewState {
    /** Currently selected node ID */
    selectedNodeId: string | null;
    /** Zoom level (1.0 = 100%) */
    zoom: number;
    /** Pan offset */
    pan: { x: number; y: number };
}

export interface MindMapDocumentViewState {
    zoom: number;
    pan: { x: number; y: number };
}
