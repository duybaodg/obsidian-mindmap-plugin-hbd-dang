import { MindMapConnection, MindMapNode } from "./models";
import { layoutTree, LayoutPosition } from "./layout";

interface MindMapCanvasCallbacks {
    onNodeSelect: (nodeId: string, additive: boolean) => void;
    onBoxSelect: (nodeIds: string[], additive: boolean) => void;
    onNodeRename: (nodeId: string) => void;
    onNodeRenameCommit: (nodeId: string, content: string) => void;
    onNodeContextMenu: (nodeId: string, event: MouseEvent) => void;
    onNodeAddChild: (nodeId: string) => void;
    onNodeDelete: (nodeId: string) => void;
    onNodeToggleCollapse: (nodeId: string) => void;
    onNodeMove: (nodeId: string, position: LayoutPosition) => void;
    onNodeDrop: (nodeId: string, targetNodeId: string | null, position: LayoutPosition, merge: boolean) => void;
    onNodeConnect: (fromNodeId: string, toNodeId: string) => void;
    onNodeMerge: (sourceNodeId: string, targetNodeId: string) => void;
}

interface DragState {
    nodeId: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
}

interface BoxSelectState {
    pointerId: number;
    start: LayoutPosition;
    current: LayoutPosition;
    additive: boolean;
}

export class MindMapCanvas {
    private static readonly NODE_WIDTH = 160;
    private static readonly NODE_HEIGHT = 48;
    private static readonly PADDING = 72;

    private container: HTMLElement;
    private callbacks: MindMapCanvasCallbacks;
    private svgElement: SVGSVGElement | null = null;
    private positions: Map<string, LayoutPosition> = new Map();
    private nodeElements: Map<string, SVGGElement> = new Map();
    private visibleNodes: MindMapNode[] = [];
    private editingNodeId: string | null = null;
    private connectSourceId: string | null = null;
    private mergeSourceId: string | null = null;
    private pan: LayoutPosition = { x: 0, y: 0 };
    private dragState: DragState | null = null;
    private boxSelectState: BoxSelectState | null = null;
    private lastClickNodeId: string | null = null;
    private lastClickAt = 0;
    private lastContextMenuNodeId: string | null = null;
    private lastContextMenuAt = 0;

    constructor(container: HTMLElement, callbacks: MindMapCanvasCallbacks) {
        this.container = container;
        this.callbacks = callbacks;
    }

    render(
        root: MindMapNode,
        connections: MindMapConnection[],
        selectedNodeIds: string[],
        connectSourceId: string | null,
        mergeSourceId: string | null,
        editingNodeId: string | null,
        zoom: number,
        pan: LayoutPosition
    ): void {
        this.visibleNodes = this.getVisibleNodes(root);
        this.positions = layoutTree(root);
        this.applySavedPositions();
        this.normalizePositions();
        this.connectSourceId = connectSourceId;
        this.mergeSourceId = mergeSourceId;
        this.editingNodeId = editingNodeId;
        this.pan = pan;

        this.createSVG();
        this.updateViewBox(zoom);
        this.renderEdges(root);
        this.renderConnections(connections);
        this.renderNodes(root, new Set(selectedNodeIds));
    }

    private createSVG(): void {
        if (!this.svgElement) {
            this.svgElement = activeDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
            this.svgElement.classList.add("mindmap-svg");
            this.svgElement.addEventListener("pointerdown", (event) => this.handleSvgPointerDown(event));
            this.svgElement.addEventListener("contextmenu", (event) => this.handleSvgContextMenu(event));
            this.svgElement.addEventListener("pointermove", (event) => this.handlePointerMove(event));
            this.svgElement.addEventListener("pointerup", (event) => this.handlePointerUp(event));
            this.svgElement.addEventListener("pointercancel", () => {
                this.dragState = null;
                this.boxSelectState = null;
            });
            this.container.appendChild(this.svgElement);
        }

        this.svgElement.innerHTML = "";
        this.nodeElements.clear();
    }

    private getVisibleNodes(root: MindMapNode): MindMapNode[] {
        const nodes: MindMapNode[] = [];

        const visit = (node: MindMapNode): void => {
            nodes.push(node);
            if (node.collapsed) return;
            node.children.forEach(visit);
        };

        visit(root);
        return nodes;
    }

    private applySavedPositions(): void {
        for (const node of this.visibleNodes) {
            if (node.position) {
                this.positions.set(node.id, { ...node.position });
            }
        }
    }

    private normalizePositions(): void {
        if (this.positions.size === 0) return;

        let minX = Infinity;
        let minY = Infinity;

        for (const pos of this.positions.values()) {
            minX = Math.min(minX, pos.x - MindMapCanvas.NODE_WIDTH / 2);
            minY = Math.min(minY, pos.y);
        }

        if (minX >= MindMapCanvas.PADDING && minY >= MindMapCanvas.PADDING) {
            return;
        }

        const offsetX = Math.max(0, MindMapCanvas.PADDING - minX);
        const offsetY = Math.max(0, MindMapCanvas.PADDING - minY);

        for (const [id, pos] of this.positions) {
            this.positions.set(id, {
                x: pos.x + offsetX,
                y: pos.y + offsetY
            });
        }
    }

    private updateViewBox(zoom: number): void {
        if (!this.svgElement || this.positions.size === 0) return;

        let maxX = 0;
        let maxY = 0;

        for (const pos of this.positions.values()) {
            maxX = Math.max(maxX, pos.x + MindMapCanvas.NODE_WIDTH / 2);
            maxY = Math.max(maxY, pos.y + MindMapCanvas.NODE_HEIGHT);
        }

        const width = Math.max(
            this.container.clientWidth,
            maxX + MindMapCanvas.PADDING + Math.max(this.pan.x, 0)
        );
        const height = Math.max(
            this.container.clientHeight,
            maxY + MindMapCanvas.PADDING + Math.max(this.pan.y, 0)
        );

        this.svgElement.setAttribute("viewBox", `0 0 ${width} ${height}`);
        this.svgElement.style.width = `${width * zoom}px`;
        this.svgElement.style.height = `${height * zoom}px`;
    }

    private renderEdges(node: MindMapNode): void {
        const nodePos = this.positions.get(node.id);
        if (!nodePos || node.collapsed) return;

        for (const child of node.children) {
            const childPos = this.positions.get(child.id);
            if (!childPos) continue;

            this.renderEdge(nodePos, childPos);
            this.renderEdges(child);
        }
    }

    private renderEdge(from: LayoutPosition, to: LayoutPosition): void {
        if (!this.svgElement) return;

        const path = activeDocument.createElementNS("http://www.w3.org/2000/svg", "path");
        const displayFrom = this.toDisplayPosition(from);
        const displayTo = this.toDisplayPosition(to);
        const startX = displayFrom.x + MindMapCanvas.NODE_WIDTH / 2;
        const startY = displayFrom.y + MindMapCanvas.NODE_HEIGHT / 2;
        const endX = displayTo.x - MindMapCanvas.NODE_WIDTH / 2;
        const endY = displayTo.y + MindMapCanvas.NODE_HEIGHT / 2;
        const controlOffset = Math.max(60, Math.abs(endX - startX) / 2);
        const d = `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`;

        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke-width", "2");
        path.setAttribute("class", "mindmap-edge");

        this.svgElement.appendChild(path);
    }

    private renderConnections(connections: MindMapConnection[]): void {
        if (!this.svgElement) return;

        for (const connection of connections) {
            const from = this.positions.get(connection.fromNodeId);
            const to = this.positions.get(connection.toNodeId);
            if (!from || !to) continue;

            const path = this.createEdgePath(from, to);
            path.setAttribute("class", "mindmap-edge mindmap-cross-connection");
            this.svgElement.appendChild(path);
        }
    }

    private createEdgePath(from: LayoutPosition, to: LayoutPosition): SVGPathElement {
        const path = activeDocument.createElementNS("http://www.w3.org/2000/svg", "path");
        const displayFrom = this.toDisplayPosition(from);
        const displayTo = this.toDisplayPosition(to);
        const startX = displayFrom.x + MindMapCanvas.NODE_WIDTH / 2;
        const startY = displayFrom.y + MindMapCanvas.NODE_HEIGHT / 2;
        const endX = displayTo.x - MindMapCanvas.NODE_WIDTH / 2;
        const endY = displayTo.y + MindMapCanvas.NODE_HEIGHT / 2;
        const controlOffset = Math.max(60, Math.abs(endX - startX) / 2);
        const d = `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`;

        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke-width", "2");
        return path;
    }

    private renderNodes(node: MindMapNode, selectedNodeIds: Set<string>): void {
        this.renderNode(node, selectedNodeIds.has(node.id));

        if (node.collapsed) return;

        for (const child of node.children) {
            this.renderNodes(child, selectedNodeIds);
        }
    }

    private renderNode(node: MindMapNode, isSelected: boolean): void {
        if (!this.svgElement) return;

        const pos = this.positions.get(node.id);
        if (!pos) return;

        const g = activeDocument.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("data-node-id", node.id);
        g.setAttribute("class", "mindmap-node");
        this.setNodeTransform(g, pos);
        g.addEventListener("pointerdown", (event) => this.handleNodePointerDown(event, node.id));
        g.addEventListener("pointerup", (event) => this.handleNodePointerUp(event, node.id));
        g.addEventListener("contextmenu", (event) => this.handleNodeContextMenu(event, node.id));

        const rect = activeDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("width", String(MindMapCanvas.NODE_WIDTH));
        rect.setAttribute("height", String(MindMapCanvas.NODE_HEIGHT));
        rect.setAttribute("rx", "8");
        rect.setAttribute("ry", "8");
        rect.setAttribute("class", this.getNodeClass(node, isSelected));
        g.appendChild(rect);

        if (node.children.length > 0 && node.id !== this.editingNodeId) {
            const toggle = activeDocument.createElementNS("http://www.w3.org/2000/svg", "g");
            toggle.setAttribute("class", "mindmap-node-action");
            toggle.setAttribute("data-node-action", "toggle");
            toggle.setAttribute("transform", "translate(12, 24)");

            const toggleCircle = activeDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
            toggleCircle.setAttribute("r", "10");
            toggleCircle.setAttribute("class", "mindmap-node-action-circle");
            toggle.appendChild(toggleCircle);

            const toggleText = activeDocument.createElementNS("http://www.w3.org/2000/svg", "text");
            toggleText.setAttribute("text-anchor", "middle");
            toggleText.setAttribute("y", "4");
            toggleText.setAttribute("class", "mindmap-node-action-text");
            toggleText.textContent = node.collapsed ? "+" : "-";
            toggle.appendChild(toggleText);

            g.appendChild(toggle);
        }

        if (node.id === this.editingNodeId) {
            this.renderInlineEditor(g, node);
        } else {
            const text = activeDocument.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute("x", String(MindMapCanvas.NODE_WIDTH / 2));
            text.setAttribute("y", "29");
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("class", "mindmap-node-label");
            text.textContent = this.truncate(node.content);
            g.appendChild(text);
        }

        if (node.children.length > 0) {
            const badge = activeDocument.createElementNS("http://www.w3.org/2000/svg", "text");
            badge.setAttribute("x", "30");
            badge.setAttribute("y", "43");
            badge.setAttribute("text-anchor", "middle");
            badge.setAttribute("class", "mindmap-node-count");
            badge.textContent = node.collapsed ? `+${node.children.length}` : String(node.children.length);
            g.appendChild(badge);
        }

        if (node.note) {
            const noteBadge = activeDocument.createElementNS("http://www.w3.org/2000/svg", "g");
            noteBadge.setAttribute("class", "mindmap-node-note-indicator");
            noteBadge.setAttribute("transform", "translate(0, 0)");

            const noteCircle = activeDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
            noteCircle.setAttribute("cx", "0");
            noteCircle.setAttribute("cy", "0");
            noteCircle.setAttribute("r", "8");
            noteCircle.setAttribute("class", "mindmap-node-note-bubble");
            noteBadge.appendChild(noteCircle);

            const noteText = activeDocument.createElementNS("http://www.w3.org/2000/svg", "text");
            noteText.setAttribute("text-anchor", "middle");
            noteText.setAttribute("y", "4");
            noteText.setAttribute("class", "mindmap-node-note-text");
            noteText.textContent = "i";
            noteBadge.appendChild(noteText);

            g.appendChild(noteBadge);
        }

        const add = activeDocument.createElementNS("http://www.w3.org/2000/svg", "g");
        add.setAttribute("class", "mindmap-node-action");
        add.setAttribute("data-node-action", "add-child");
        add.setAttribute("transform", `translate(${MindMapCanvas.NODE_WIDTH - 12}, 24)`);

        const addCircle = activeDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
        addCircle.setAttribute("r", "10");
        addCircle.setAttribute("class", "mindmap-node-action-circle");
        add.appendChild(addCircle);

        const addText = activeDocument.createElementNS("http://www.w3.org/2000/svg", "text");
        addText.setAttribute("text-anchor", "middle");
        addText.setAttribute("y", "4");
        addText.setAttribute("class", "mindmap-node-action-text");
        addText.textContent = "+";
        add.appendChild(addText);

        g.appendChild(add);

        const remove = activeDocument.createElementNS("http://www.w3.org/2000/svg", "g");
        remove.setAttribute("class", "mindmap-node-action mindmap-node-action-danger");
        remove.setAttribute("data-node-action", "delete");
        remove.setAttribute("transform", `translate(${MindMapCanvas.NODE_WIDTH - 12}, -2)`);

        const removeCircle = activeDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
        removeCircle.setAttribute("r", "9");
        removeCircle.setAttribute("class", "mindmap-node-action-circle");
        remove.appendChild(removeCircle);

        const removeText = activeDocument.createElementNS("http://www.w3.org/2000/svg", "text");
        removeText.setAttribute("text-anchor", "middle");
        removeText.setAttribute("y", "4");
        removeText.setAttribute("class", "mindmap-node-action-text");
        removeText.textContent = "x";
        remove.appendChild(removeText);

        g.appendChild(remove);

        this.svgElement.appendChild(g);
        this.nodeElements.set(node.id, g);
    }

    private renderInlineEditor(group: SVGGElement, node: MindMapNode): void {
        const foreignObject = activeDocument.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
        foreignObject.setAttribute("x", "14");
        foreignObject.setAttribute("y", "8");
        foreignObject.setAttribute("width", String(MindMapCanvas.NODE_WIDTH - 28));
        foreignObject.setAttribute("height", String(MindMapCanvas.NODE_HEIGHT - 16));

        const input = activeDocument.createElement("input");
        input.type = "text";
        input.value = node.content;
        input.className = "mindmap-inline-rename";
        input.addEventListener("pointerdown", (event) => event.stopPropagation());
        input.addEventListener("pointerup", (event) => event.stopPropagation());
        input.addEventListener("click", (event) => event.stopPropagation());
        input.addEventListener("dblclick", (event) => event.stopPropagation());

        let committed = false;
        const commit = (value: string): void => {
            if (committed) return;
            committed = true;
            this.callbacks.onNodeRenameCommit(node.id, value);
        };

        input.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
                event.preventDefault();
                commit(input.value);
            }
            if (event.key === "Escape") {
                event.preventDefault();
                commit(node.content);
            }
        });
        input.addEventListener("blur", () => commit(input.value));

        foreignObject.appendChild(input);
        group.appendChild(foreignObject);

        window.setTimeout(() => {
            input.focus();
            input.select();
        }, 0);
    }

    private getNodeClass(node: MindMapNode, isSelected: boolean): string {
        const classes = ["mindmap-node-box"];
        if (isSelected) classes.push("is-selected");
        if (node.id === this.connectSourceId) classes.push("is-connecting");
        if (node.id === this.mergeSourceId) classes.push("is-merging");
        return classes.join(" ");
    }

    private truncate(content: string): string {
        return content.length > 22 ? `${content.slice(0, 19)}...` : content;
    }

    private handleNodePointerDown(event: PointerEvent, nodeId: string): void {
        if (!this.svgElement) return;

        if (event.button === 2) {
            event.preventDefault();
            event.stopPropagation();
            this.openNodeContextMenu(nodeId, event);
            return;
        }

        if (event.button !== 0) {
            return;
        }

        event.stopPropagation();

        const action = this.getAction(event.target);
        if (action) {
            return;
        }

        const position = this.positions.get(nodeId);
        if (!position) return;

        const point = this.toSvgPoint(event.clientX, event.clientY);
        this.dragState = {
            nodeId,
            pointerId: event.pointerId,
            offsetX: point.x - (position.x + this.pan.x - MindMapCanvas.NODE_WIDTH / 2),
            offsetY: point.y - (position.y + this.pan.y),
            moved: false
        };
        this.svgElement.setPointerCapture(event.pointerId);
    }

    private handleSvgPointerDown(event: PointerEvent): void {
        if (!this.svgElement || event.button !== 0 || !event.shiftKey) return;
        if (event.target instanceof Element && event.target.closest("[data-node-id]")) return;

        event.preventDefault();
        const start = this.toSvgPoint(event.clientX, event.clientY);
        this.boxSelectState = {
            pointerId: event.pointerId,
            start,
            current: start,
            additive: true
        };
        this.svgElement.setPointerCapture(event.pointerId);
        this.renderSelectionBox();
    }

    private handleNodeContextMenu(event: MouseEvent, nodeId: string): void {
        event.preventDefault();
        event.stopPropagation();
        this.openNodeContextMenu(nodeId, event);
    }

    private handleSvgContextMenu(event: MouseEvent): void {
        const nodeId = this.getNodeIdFromTarget(event.target);
        if (!nodeId) return;

        event.preventDefault();
        event.stopPropagation();
        this.openNodeContextMenu(nodeId, event);
    }

    private openNodeContextMenu(nodeId: string, event: MouseEvent): void {
        const now = Date.now();
        if (this.lastContextMenuNodeId === nodeId && now - this.lastContextMenuAt < 350) {
            return;
        }

        this.lastContextMenuNodeId = nodeId;
        this.lastContextMenuAt = now;
        this.dragState = null;
        this.boxSelectState = null;
        this.callbacks.onNodeContextMenu(nodeId, event);
    }

    private handleNodePointerUp(event: PointerEvent, nodeId: string): void {
        const action = this.getAction(event.target);
        if (action === "add-child") {
            event.stopPropagation();
            this.callbacks.onNodeAddChild(nodeId);
            return;
        }
        if (action === "delete") {
            event.stopPropagation();
            this.callbacks.onNodeDelete(nodeId);
            return;
        }
        if (action === "toggle") {
            event.stopPropagation();
            this.callbacks.onNodeToggleCollapse(nodeId);
            return;
        }
    }

    private handlePointerMove(event: PointerEvent): void {
        if (this.boxSelectState && this.boxSelectState.pointerId === event.pointerId) {
            event.preventDefault();
            this.boxSelectState.current = this.toSvgPoint(event.clientX, event.clientY);
            this.renderSelectionBox();
            return;
        }

        if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;

        event.preventDefault();

        const point = this.toSvgPoint(event.clientX, event.clientY);
        const position = {
            x: point.x - this.dragState.offsetX + MindMapCanvas.NODE_WIDTH / 2 - this.pan.x,
            y: point.y - this.dragState.offsetY - this.pan.y
        };
        this.positions.set(this.dragState.nodeId, position);
        this.dragState.moved = true;

        const element = this.nodeElements.get(this.dragState.nodeId);
        if (element) {
            this.setNodeTransform(element, position);
        }
    }

    private handlePointerUp(event: PointerEvent): void {
        if (this.boxSelectState && this.boxSelectState.pointerId === event.pointerId) {
            const state = this.boxSelectState;
            this.boxSelectState = null;
            if (this.svgElement?.hasPointerCapture(event.pointerId)) {
                this.svgElement.releasePointerCapture(event.pointerId);
            }
            this.removeSelectionBox();
            this.callbacks.onBoxSelect(this.getNodesInBox(state), state.additive);
            return;
        }

        if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;

        const dragState = this.dragState;
        this.dragState = null;

        if (this.svgElement?.hasPointerCapture(event.pointerId)) {
            this.svgElement.releasePointerCapture(event.pointerId);
        }

        const position = this.positions.get(dragState.nodeId);
        if (!position) return;

        if (!dragState.moved) {
            this.activateNode(dragState.nodeId, event.shiftKey);
            return;
        }

        const targetNodeId = this.getDropTarget(event.clientX, event.clientY, dragState.nodeId);
        if (targetNodeId) {
            this.callbacks.onNodeDrop(dragState.nodeId, targetNodeId, position, event.shiftKey);
            return;
        }

        this.callbacks.onNodeMove(dragState.nodeId, position);
    }

    private activateNode(nodeId: string, additive: boolean): void {
        if (this.connectSourceId && this.connectSourceId !== nodeId) {
            this.resetClickState();
            this.callbacks.onNodeConnect(this.connectSourceId, nodeId);
            return;
        }
        if (this.mergeSourceId && this.mergeSourceId !== nodeId) {
            this.resetClickState();
            this.callbacks.onNodeMerge(this.mergeSourceId, nodeId);
            return;
        }

        const now = Date.now();
        if (this.lastClickNodeId === nodeId && now - this.lastClickAt <= 420) {
            this.resetClickState();
            this.callbacks.onNodeRename(nodeId);
            return;
        }

        this.lastClickNodeId = nodeId;
        this.lastClickAt = now;
        this.callbacks.onNodeSelect(nodeId, additive);
    }

    private resetClickState(): void {
        this.lastClickNodeId = null;
        this.lastClickAt = 0;
    }

    private getDropTarget(clientX: number, clientY: number, draggedNodeId: string): string | null {
        for (const element of activeDocument.elementsFromPoint(clientX, clientY)) {
            const nodeElement = element.closest("[data-node-id]");
            const nodeId = nodeElement?.getAttribute("data-node-id") ?? null;
            if (nodeId && nodeId !== draggedNodeId) {
                return nodeId;
            }
        }

        return null;
    }

    private getAction(target: EventTarget | null): string | null {
        if (!(target instanceof Element)) return null;

        const actionElement = target.closest("[data-node-action]");
        return actionElement?.getAttribute("data-node-action") ?? null;
    }

    private getNodeIdFromTarget(target: EventTarget | null): string | null {
        if (!(target instanceof Element)) return null;

        return target.closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;
    }

    private toSvgPoint(clientX: number, clientY: number): LayoutPosition {
        if (!this.svgElement) return { x: clientX, y: clientY };

        const point = this.svgElement.createSVGPoint();
        point.x = clientX;
        point.y = clientY;

        const matrix = this.svgElement.getScreenCTM();
        if (!matrix) return { x: clientX, y: clientY };

        const transformed = point.matrixTransform(matrix.inverse());
        return { x: transformed.x, y: transformed.y };
    }

    private setNodeTransform(element: SVGGElement, position: LayoutPosition): void {
        const displayPosition = this.toDisplayPosition(position);
        element.setAttribute(
            "transform",
            `translate(${displayPosition.x - MindMapCanvas.NODE_WIDTH / 2}, ${displayPosition.y})`
        );
    }

    private renderSelectionBox(): void {
        if (!this.svgElement || !this.boxSelectState) return;

        let rect = this.svgElement.querySelector<SVGRectElement>(".mindmap-selection-box");
        if (!rect) {
            rect = activeDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("class", "mindmap-selection-box");
            this.svgElement.appendChild(rect);
        }

        const { start, current } = this.boxSelectState;
        const x = Math.min(start.x, current.x);
        const y = Math.min(start.y, current.y);
        const width = Math.abs(current.x - start.x);
        const height = Math.abs(current.y - start.y);

        rect.setAttribute("x", String(x));
        rect.setAttribute("y", String(y));
        rect.setAttribute("width", String(width));
        rect.setAttribute("height", String(height));
    }

    private removeSelectionBox(): void {
        this.svgElement?.querySelector(".mindmap-selection-box")?.remove();
    }

    private getNodesInBox(state: BoxSelectState): string[] {
        const left = Math.min(state.start.x, state.current.x) - this.pan.x;
        const right = Math.max(state.start.x, state.current.x) - this.pan.x;
        const top = Math.min(state.start.y, state.current.y) - this.pan.y;
        const bottom = Math.max(state.start.y, state.current.y) - this.pan.y;
        const selected: string[] = [];

        for (const [nodeId, position] of this.positions) {
            const nodeLeft = position.x - MindMapCanvas.NODE_WIDTH / 2;
            const nodeRight = position.x + MindMapCanvas.NODE_WIDTH / 2;
            const nodeTop = position.y;
            const nodeBottom = position.y + MindMapCanvas.NODE_HEIGHT;
            if (nodeRight >= left && nodeLeft <= right && nodeBottom >= top && nodeTop <= bottom) {
                selected.push(nodeId);
            }
        }

        return selected;
    }

    private toDisplayPosition(position: LayoutPosition): LayoutPosition {
        return {
            x: position.x + this.pan.x,
            y: position.y + this.pan.y
        };
    }

    getContentBounds(): { width: number; height: number } {
        let maxX = 0;
        let maxY = 0;

        for (const pos of this.positions.values()) {
            maxX = Math.max(maxX, pos.x + MindMapCanvas.NODE_WIDTH / 2);
            maxY = Math.max(maxY, pos.y + MindMapCanvas.NODE_HEIGHT);
        }

        return {
            width: maxX + MindMapCanvas.PADDING,
            height: maxY + MindMapCanvas.PADDING
        };
    }

    getViewportSize(): { width: number; height: number } {
        return {
            width: this.container.clientWidth,
            height: this.container.clientHeight
        };
    }

    getSvgElement(): SVGSVGElement | null {
        return this.svgElement;
    }

    centerNode(nodeId: string, zoom: number): boolean {
        const center = this.getNodeContentCenter(nodeId, zoom);
        if (!center) return false;

        this.container.scrollLeft = Math.max(0, center.x - this.container.clientWidth / 2);
        this.container.scrollTop = Math.max(0, center.y - this.container.clientHeight / 2);
        return true;
    }

    private getNodeContentCenter(nodeId: string, zoom: number): LayoutPosition | null {
        const position = this.positions.get(nodeId);
        if (!position) return null;

        const displayPosition = this.toDisplayPosition(position);
        return {
            x: displayPosition.x * zoom,
            y: (displayPosition.y + MindMapCanvas.NODE_HEIGHT / 2) * zoom
        };
    }

    clear(): void {
        if (this.svgElement) {
            this.svgElement.innerHTML = "";
        }
        this.nodeElements.clear();
        this.positions.clear();
        this.visibleNodes = [];
        this.dragState = null;
        this.boxSelectState = null;
        this.resetClickState();
    }
}
