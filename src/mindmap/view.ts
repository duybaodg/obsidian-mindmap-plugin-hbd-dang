import { App, ItemView, Menu, Modal, Notice, normalizePath, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { MindMapData, MindMapNode, MindMapViewState } from "./models";
import { parseMindMap, serializeMindMap, createEmptyMindMap } from "../storage/parser";
import { MindMapCanvas } from "./canvas";
import { layoutTree, LayoutPosition } from "./layout";
import { CommandHistory } from "./history";
import {
    addChildNode as addTreeChildNode,
    addSiblingNode as addTreeSiblingNode,
    clearPositions,
    createNode,
    deleteNode as deleteTreeNode,
    findChildRef,
    findNode,
    findParent,
    getGroupPosition,
    groupSiblingNodes,
    moveNode as moveTreeNode,
    renameNode as renameTreeNode,
    reparentNode as reparentTreeNode,
    toggleCollapse as toggleTreeCollapse
} from "./tree";

export const VIEW_TYPE = "obsidian-mindmap-view";

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.1;
const AUTOSAVE_DELAY_MS = 800;
type DownloadFormat = "png" | "jpeg" | "pdf";

interface PanState {
    pointerId: number;
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
}

interface SavedMindMapViewState {
    filePath?: string | null; // legacy support for saved state
    data?: MindMapData | null;
    view?: MindMapViewState;
}

export class MindMapView extends ItemView {
    private data: MindMapData | null = null;
    private canvas: MindMapCanvas | null = null;
    private state: MindMapViewState = {
        selectedNodeId: null,
        zoom: 1.0,
        pan: { x: 0, y: 0 }
    };
    private file: TFile | null = null;
    private connectSourceId: string | null = null;
    private mergeSourceId: string | null = null;
    private editingNodeId: string | null = null;
    private panState: PanState | null = null;
    private selectedNodeIds: Set<string> = new Set();
    private history = new CommandHistory();
    private autosaveTimer: number | null = null;
    private statusEl: HTMLElement | null = null;
    private minimapEl: HTMLElement | null = null;
    private isSpacePanPressed = false;
    private connectButtonEl: HTMLButtonElement | null = null;
    private mergeButtonEl: HTMLButtonElement | null = null;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE;
    }

    getDisplayText(): string {
        return "Mind Map";
    }

    async onOpen() {
        this.containerEl.empty();
        this.containerEl.addClass("mindmap-container");

        const toolbar = this.containerEl.createDiv("mindmap-toolbar");
        toolbar.createEl("button", { text: "Zoom -" }, (button) => {
            button.addEventListener("click", () => this.adjustZoom(-ZOOM_STEP));
        });
        toolbar.createEl("button", { text: "Zoom +" }, (button) => {
            button.addEventListener("click", () => this.adjustZoom(ZOOM_STEP));
        });
        toolbar.createEl("button", { text: "100%" }, (button) => {
            button.addEventListener("click", () => this.setZoom(1));
        });
        toolbar.createEl("button", { text: "Fit" }, (button) => {
            button.addEventListener("click", () => this.fitToView());
        });
        toolbar.createEl("button", { text: "Undo" }, (button) => {
            button.addEventListener("click", () => this.undo());
        });
        toolbar.createEl("button", { text: "Redo" }, (button) => {
            button.addEventListener("click", () => this.redo());
        });
        toolbar.createEl("button", { text: "Add child" }, (button) => {
            button.addEventListener("click", () => this.addChildNode());
        });
        toolbar.createEl("button", { text: "Add sibling" }, (button) => {
            button.addEventListener("click", () => this.addSiblingNode());
        });
        toolbar.createEl("button", { text: "Rename" }, (button) => {
            button.addEventListener("click", () => this.renameNode());
        });
        toolbar.createEl("button", { text: "Connect" }, (button) => {
            this.connectButtonEl = button;
            button.addEventListener("click", () => this.startConnect());
        });
        toolbar.createEl("button", { text: "Merge" }, (button) => {
            this.mergeButtonEl = button;
            button.addEventListener("click", () => this.startMerge());
        });
        toolbar.createEl("button", { text: "Group" }, (button) => {
            button.addEventListener("click", () => this.groupSelectedNodes());
        });
        toolbar.createEl("button", { text: "Auto layout" }, (button) => {
            button.addEventListener("click", () => this.autoLayout());
        });
        toolbar.createEl("button", { text: "Delete" }, (button) => {
            button.addEventListener("click", () => this.deleteNode());
        });
        toolbar.createEl("button", { text: "Save" }, (button) => {
            button.addEventListener("click", () => {
                void this.save(true);
            });
        });
        toolbar.createEl("button", { text: "Download" }, (button) => {
            button.addEventListener("click", (event) => this.openDownloadMenu(event));
        });
        toolbar.createEl("button", { text: "Guide" }, (button) => {
            button.addEventListener("click", () => this.openGuide());
        });
        this.statusEl = toolbar.createSpan("mindmap-mode-status");

        const canvasContainer = this.containerEl.createDiv("mindmap-canvas");
        canvasContainer.tabIndex = 0;
        canvasContainer.addEventListener("mousedown", () => {
            canvasContainer.focus();
        });
        this.setupCanvasPanning(canvasContainer);
        canvasContainer.addEventListener("wheel", (event) => {
            event.preventDefault();
            this.adjustZoom(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP);
        }, { passive: false });
        this.minimapEl = canvasContainer.createDiv("mindmap-minimap");
        this.canvas = new MindMapCanvas(canvasContainer, {
            onNodeSelect: (nodeId, additive) => {
                this.selectNode(nodeId, additive);
                this.render();
            },
            onBoxSelect: (nodeIds, additive) => {
                this.selectNodes(nodeIds, additive);
                this.render();
            },
            onNodeRename: (nodeId) => {
                this.renameNode(nodeId);
            },
            onNodeRenameCommit: (nodeId, content) => {
                this.commitInlineRename(nodeId, content);
            },
            onNodeContextMenu: (nodeId, event) => {
                this.openNodeMenu(nodeId, event);
            },
            onNodeAddChild: (nodeId) => {
                this.addChildNode(nodeId);
            },
            onNodeDelete: (nodeId) => {
                this.deleteNode(nodeId);
            },
            onNodeToggleCollapse: (nodeId) => {
                this.toggleCollapse(nodeId);
            },
            onNodeMove: (nodeId, position) => {
                this.moveNode(nodeId, position);
            },
            onNodeDrop: (nodeId, targetNodeId, position, merge) => {
                this.dropNode(nodeId, targetNodeId, position, merge);
            },
            onNodeConnect: (fromNodeId, toNodeId) => {
                this.connectNodes(fromNodeId, toNodeId);
            },
            onNodeMerge: (sourceNodeId, targetNodeId) => {
                this.mergeNodes(sourceNodeId, targetNodeId);
            }
        });

        this.setupSpacePanHandlers();
        this.setupGlobalHotkeys();
        this.updateStatus();
        if (this.data) {
            this.render();
        } else {
            this.createNew();
        }
    }

    async onClose() {
        if (this.autosaveTimer !== null) {
            window.clearTimeout(this.autosaveTimer);
            this.autosaveTimer = null;
        }
        if (this.data) {
            await this.save(false);
        }
        this.canvas?.clear();
        this.minimapEl = null;
    }

    getState(): Record<string, unknown> {
        return {
            ...super.getState(),
            filePath: this.file?.path ?? null,
            data: this.data,
            view: this.state
        };
    }

    async setState(state: unknown, result: ViewStateResult): Promise<void> {
        await super.setState(state, result);

        const savedState = this.parseSavedState(state);
        if (savedState.filePath) {
            await this.loadFile(savedState.filePath);
            return;
        }

        if (savedState.data) {
            this.data = savedState.data;
            this.file = null;
            this.state = savedState.view ?? {
                selectedNodeId: this.data.root.id,
                zoom: this.data.view?.zoom ?? 1,
                pan: this.data.view?.pan ?? { x: 0, y: 0 }
            };
            this.selectedNodeIds = new Set([this.state.selectedNodeId ?? this.data.root.id]);
            this.connectSourceId = null;
            this.mergeSourceId = null;
            this.editingNodeId = null;
            this.history.clear();
            this.render();
        }
    }

    private parseSavedState(state: unknown): SavedMindMapViewState {
        if (!state || typeof state !== "object") return {};

        const record = state as Record<string, unknown>;
        return {
            filePath: typeof record.filePath === "string" ? record.filePath : null,
            data: this.isMindMapData(record.data) ? record.data : null,
            view: this.isMindMapViewState(record.view) ? record.view : undefined
        };
    }

    private isMindMapData(value: unknown): value is MindMapData {
        if (!value || typeof value !== "object") return false;
        const record = value as Record<string, unknown>;
        const root = record.root as Record<string, unknown> | undefined;
        return typeof record.version === "string"
            && !!root
            && typeof root.id === "string"
            && typeof root.content === "string"
            && Array.isArray(root.children);
    }

    private isMindMapViewState(value: unknown): value is MindMapViewState {
        if (!value || typeof value !== "object") return false;
        const record = value as Record<string, unknown>;
        const pan = record.pan as Record<string, unknown> | undefined;
        return (typeof record.selectedNodeId === "string" || record.selectedNodeId === null)
            && typeof record.zoom === "number"
            && !!pan
            && typeof pan.x === "number"
            && typeof pan.y === "number";
    }

    async loadFile(path: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            this.file = file;
        }

        try {
            const content = await this.app.vault.adapter.read(path);
            const parsed = parseMindMap(content);

            if (parsed) {
                this.data = parsed;
            } else {
                this.data = createEmptyMindMap();
            }
        } catch (error) {
            console.error('Failed to load mind map:', error);
            this.data = createEmptyMindMap();
        }

        this.state.selectedNodeId = this.data.root.id;
        this.state.zoom = this.data.view?.zoom ?? 1;
        this.state.pan = this.data.view?.pan ?? { x: 0, y: 0 };
        this.selectedNodeIds = new Set([this.data.root.id]);
        this.connectSourceId = null;
        this.mergeSourceId = null;
        this.editingNodeId = null;
        this.history.clear();
        this.render();
    }

    createNew(): void {
        this.data = createEmptyMindMap();
        this.file = null;
        this.state.selectedNodeId = this.data.root.id;
        this.state.zoom = this.data.view?.zoom ?? 1;
        this.state.pan = this.data.view?.pan ?? { x: 0, y: 0 };
        this.selectedNodeIds = new Set([this.data.root.id]);
        this.connectSourceId = null;
        this.mergeSourceId = null;
        this.editingNodeId = null;
        this.history.clear();
        this.render();
    }

    private render(): void {
        if (!this.data || !this.canvas) return;

        this.canvas.render(
            this.data.root,
            this.data.connections ?? [],
            Array.from(this.selectedNodeIds),
            this.connectSourceId,
            this.mergeSourceId,
            this.editingNodeId,
            this.state.zoom,
            this.state.pan
        );
        this.renderMinimap();
        this.updateStatus();
    }

    private adjustZoom(delta: number): void {
        this.setZoom(Number((this.state.zoom + delta).toFixed(2)));
    }

    private setZoom(zoom: number): void {
        const oldZoom = this.state.zoom;
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(zoom.toFixed(2))));
        if (newZoom === oldZoom) return;

        const focusNodeId = this.state.selectedNodeId ?? this.data?.root.id ?? null;
        this.state.zoom = newZoom;
        this.updatePersistedViewState();
        this.render();
        if (focusNodeId && this.canvas) {
            this.canvas.centerNode(focusNodeId, newZoom);
        }
        this.scheduleAutosave();
    }

    private selectNode(nodeId: string, additive: boolean): void {
        if (additive) {
            if (this.selectedNodeIds.has(nodeId)) {
                this.selectedNodeIds.delete(nodeId);
            } else {
                this.selectedNodeIds.add(nodeId);
            }
            if (this.selectedNodeIds.size === 0) {
                this.selectedNodeIds.add(nodeId);
            }
        } else {
            this.selectedNodeIds = new Set([nodeId]);
        }

        this.state.selectedNodeId = nodeId;
        this.connectSourceId = null;
        this.mergeSourceId = null;
        this.editingNodeId = null;
    }

    private selectNodes(nodeIds: string[], additive: boolean): void {
        if (nodeIds.length === 0) return;

        if (additive) {
            for (const nodeId of nodeIds) {
                this.selectedNodeIds.add(nodeId);
            }
        } else {
            this.selectedNodeIds = new Set(nodeIds);
        }

        this.state.selectedNodeId = nodeIds[nodeIds.length - 1];
        this.connectSourceId = null;
        this.mergeSourceId = null;
        this.editingNodeId = null;
    }

    private runCommand(label: string, mutate: () => boolean | void): boolean {
        if (!this.data) return false;

        const command = this.history.execute(label, this.data, mutate);
        if (!command) return false;

        this.render();
        this.scheduleAutosave();
        return true;
    }

    private undo(): void {
        const previous = this.history.undo();
        if (!previous) return;

        this.data = previous;
        this.state.selectedNodeId = this.data.root.id;
        this.state.zoom = this.data.view?.zoom ?? this.state.zoom;
        this.state.pan = this.data.view?.pan ?? this.state.pan;
        this.selectedNodeIds = new Set([this.data.root.id]);
        this.connectSourceId = null;
        this.mergeSourceId = null;
        this.editingNodeId = null;
        this.render();
        this.scheduleAutosave();
    }

    private redo(): void {
        const next = this.history.redo();
        if (!next) return;

        this.data = next;
        this.state.selectedNodeId = this.data.root.id;
        this.state.zoom = this.data.view?.zoom ?? this.state.zoom;
        this.state.pan = this.data.view?.pan ?? this.state.pan;
        this.selectedNodeIds = new Set([this.data.root.id]);
        this.connectSourceId = null;
        this.mergeSourceId = null;
        this.editingNodeId = null;
        this.render();
        this.scheduleAutosave();
    }

    private scheduleAutosave(): void {
        if (this.autosaveTimer !== null) {
            window.clearTimeout(this.autosaveTimer);
        }
        this.autosaveTimer = window.setTimeout(() => {
            this.autosaveTimer = null;
            void this.save(false);
        }, AUTOSAVE_DELAY_MS);
    }

    private fitToView(): void {
        if (!this.canvas) return;

        const bounds = this.canvas.getContentBounds();
        const viewport = this.canvas.getViewportSize();
        if (bounds.width <= 0 || bounds.height <= 0) return;

        const zoom = Math.min(
            MAX_ZOOM,
            Math.max(MIN_ZOOM, Math.min(viewport.width / bounds.width, viewport.height / bounds.height) * 0.9)
        );
        this.state.zoom = Number(zoom.toFixed(2));
        this.state.pan = {
            x: Math.max(0, (viewport.width / this.state.zoom - bounds.width) / 2),
            y: Math.max(0, (viewport.height / this.state.zoom - bounds.height) / 2)
        };
        this.updatePersistedViewState();
        this.render();
        this.scheduleAutosave();
    }

    private updateStatus(): void {
        if (!this.statusEl) return;

        const mode = this.connectSourceId
            ? "Connect: click target"
            : this.mergeSourceId
                ? "Merge: click sibling target"
                : `${this.selectedNodeIds.size} selected`;
        const zoom = `${Math.round(this.state.zoom * 100)}%`;
        this.statusEl.setText(`${mode} · Zoom ${zoom}`);
        this.connectButtonEl?.toggleClass("is-active", this.connectSourceId !== null);
        this.mergeButtonEl?.toggleClass("is-active", this.mergeSourceId !== null);
    }

    private setupCanvasPanning(canvasContainer: HTMLElement): void {
        canvasContainer.addEventListener("pointerdown", (event) => {
            const isMiddlePan = event.button === 1;
            const isCanvasPan = event.button === 0 && !event.shiftKey && !this.isNodeEventTarget(event.target);
            const isSpacePan = event.button === 0 && this.isSpacePanPressed;
            if (!isMiddlePan && !isCanvasPan && !isSpacePan) return;

            event.preventDefault();
            canvasContainer.focus();
            canvasContainer.classList.add("is-panning");
            this.panState = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                startPanX: this.state.pan.x,
                startPanY: this.state.pan.y
            };
            canvasContainer.setPointerCapture(event.pointerId);
        });

        canvasContainer.addEventListener("pointermove", (event) => {
            if (!this.panState || this.panState.pointerId !== event.pointerId) return;

            event.preventDefault();
            this.state.pan = {
                x: this.panState.startPanX + event.clientX - this.panState.startX,
                y: this.panState.startPanY + event.clientY - this.panState.startY
            };
            this.updatePersistedViewState();
            this.render();
        });

        const stopPanning = (event: PointerEvent): void => {
            if (!this.panState || this.panState.pointerId !== event.pointerId) return;

            if (canvasContainer.hasPointerCapture(event.pointerId)) {
                canvasContainer.releasePointerCapture(event.pointerId);
            }
            canvasContainer.classList.remove("is-panning");
            this.panState = null;
            this.scheduleAutosave();
        };

        canvasContainer.addEventListener("pointerup", stopPanning);
        canvasContainer.addEventListener("pointercancel", stopPanning);
    }

    private isNodeEventTarget(target: EventTarget | null): boolean {
        return target instanceof Element && target.closest("[data-node-id]") !== null;
    }

    async save(showNotice = false): Promise<void> {
        if (!this.data) {
            if (showNotice) new Notice("Nothing to save.");
            return;
        }

        try {
            this.updatePersistedViewState();
            const filePath = this.file?.path;
            if (filePath) {
                const existingContent = await this.app.vault.adapter.exists(filePath)
                    ? await this.app.vault.adapter.read(filePath)
                    : "";
                const content = serializeMindMap(this.data, existingContent);
                await this.app.vault.adapter.write(filePath, content);
            } else {
                const content = serializeMindMap(this.data);
                const newPath = await this.getNewFilePath();
                await this.app.vault.create(newPath, content);
                const newFile = this.app.vault.getAbstractFileByPath(newPath);
                if (newFile instanceof TFile) {
                    this.file = newFile;
                }
            }
            if (showNotice) new Notice("Mind map saved.");
        } catch (error) {
            console.error("Failed to save mind map:", error);
            if (showNotice) new Notice(`Failed to save mind map: ${this.getErrorMessage(error)}`);
        }
    }

    private updatePersistedViewState(): void {
        if (!this.data) return;

        this.data.view = {
            zoom: this.state.zoom,
            pan: { ...this.state.pan }
        };
    }

    private async getNewFilePath(): Promise<string> {
        const activeFile = this.app.workspace.getActiveFile();
        const fileName = `Mind map ${new Date().toISOString().slice(0, 10)}`;
        const dir = activeFile?.parent?.path;
        const basePath = normalizePath(dir ? `${dir}/${fileName}` : fileName);

        return this.getAvailableMarkdownPath(basePath);
    }

    private async getAvailableMarkdownPath(basePath: string): Promise<string> {
        let index = 1;
        let candidate = `${basePath}.md`;

        while (await this.app.vault.adapter.exists(candidate)) {
            index += 1;
            candidate = `${basePath} ${index}.md`;
        }

        return candidate;
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error && error.message) return error.message;
        if (typeof error === "string") return error;
        return "unknown error";
    }

    private setupGlobalHotkeys(): void {
        this.registerDomEvent(window, "keydown", (event: KeyboardEvent) => {
            if (!this.isActiveMindMapView() || this.isTextInputTarget(event.target)) return;

            const handled = this.handleHotkey(event);
            if (handled) {
                event.preventDefault();
                event.stopPropagation();
            }
        });
    }

    private handleHotkey(event: KeyboardEvent): boolean {
        const isMod = event.metaKey || event.ctrlKey;
        const key = event.key;

        if (isMod && !event.shiftKey && key.toLowerCase() === "z") {
            this.undo();
            return true;
        }
        if (isMod && event.shiftKey && key.toLowerCase() === "z") {
            this.redo();
            return true;
        }
        if (isMod && key.toLowerCase() === "s") {
            void this.save(true);
            return true;
        }
        if (isMod && key === "/") {
            this.openGuide();
            return true;
        }
        if ((isMod && (key === "=" || key === "+")) || key === "+") {
            this.adjustZoom(ZOOM_STEP);
            return true;
        }
        if ((isMod && key === "-") || key === "-") {
            this.adjustZoom(-ZOOM_STEP);
            return true;
        }
        if (isMod && key === "0") {
            this.setZoom(1);
            return true;
        }
        if (key === "Tab") {
            this.addChildNode();
            return true;
        }
        if (key === "Enter") {
            this.addSiblingNode();
            return true;
        }
        if (key === "Backspace" || key === "Delete") {
            this.deleteNode();
            return true;
        }
        if (key === "F2") {
            this.renameNode();
            return true;
        }
        if (key === " ") {
            this.isSpacePanPressed = true;
            this.containerEl.querySelector(".mindmap-canvas")?.addClass("is-space-pan");
            return true;
        }

        return false;
    }

    private isActiveMindMapView(): boolean {
        return this.app.workspace.getActiveViewOfType(MindMapView) === this;
    }

    private isTextInputTarget(target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) return false;
        return target.instanceOf(HTMLInputElement)
            || target.instanceOf(HTMLTextAreaElement)
            || target.isContentEditable;
    }

    private openGuide(): void {
        new GuideModal(this.app).open();
    }

    private openDownloadMenu(event: MouseEvent): void {
        const menu = new Menu();
        for (const [format, label] of [
            ["png", "Download PNG"],
            ["jpeg", "Download JPEG"],
            ["pdf", "Download PDF"]
        ] as Array<[DownloadFormat, string]>) {
            menu.addItem((item) => {
                item
                    .setTitle(label)
                    .setIcon("download")
                    .onClick(() => {
                        void this.downloadMindMap(format);
                    });
            });
        }
        menu.showAtMouseEvent(event);
    }

    private async downloadMindMap(format: DownloadFormat): Promise<void> {
        try {
            const name = this.getDownloadBaseName();
            if (format === "pdf") {
                const image = await this.renderMindMapImage("image/jpeg");
                this.downloadBlob(this.createPdfFromJpeg(image.dataUrl, image.width, image.height), `${name}.pdf`);
            } else {
                const mime = format === "png" ? "image/png" : "image/jpeg";
                const image = await this.renderMindMapImage(mime);
                this.downloadBlob(image.blob, `${name}.${format === "png" ? "png" : "jpg"}`);
            }
            new Notice(`Mind map downloaded as ${format.toUpperCase()}.`);
        } catch (error) {
            console.error("Failed to download mind map:", error);
            new Notice(`Failed to download mind map: ${this.getErrorMessage(error)}`);
        }
    }

    private async renderMindMapImage(mime: "image/png" | "image/jpeg"): Promise<{ blob: Blob; dataUrl: string; width: number; height: number }> {
        const exportSvg = this.getExportSvg();
        const url = URL.createObjectURL(new Blob([exportSvg.svg], { type: "image/svg+xml;charset=utf-8" }));
        try {
            const image = await new Promise<HTMLImageElement>((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error("Could not render SVG export."));
                img.src = url;
            });
            const scale = 2;
            const canvas = activeDocument.createElement("canvas");
            canvas.width = exportSvg.width * scale;
            canvas.height = exportSvg.height * scale;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Canvas export is not available.");
            context.fillStyle = exportSvg.background;
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL(mime, 0.92);
            const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not create image export.")), mime, 0.92);
            });
            return { blob, dataUrl, width: canvas.width, height: canvas.height };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    private getExportSvg(): { svg: string; width: number; height: number; background: string } {
        const source = this.canvas?.getSvgElement();
        if (!source) throw new Error("No mind map canvas to export.");

        const clone = source.cloneNode(true) as SVGSVGElement;
        const [width, height] = this.getSvgSize(source);
        const background = getComputedStyle(this.containerEl).getPropertyValue("--background-primary").trim() || "#ffffff";
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.setAttribute("width", String(width));
        clone.setAttribute("height", String(height));
        this.inlineSvgStyles(source, clone);

        const backgroundRect = activeDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
        backgroundRect.setAttribute("width", String(width));
        backgroundRect.setAttribute("height", String(height));
        backgroundRect.setAttribute("fill", background);
        clone.insertBefore(backgroundRect, clone.firstChild);

        return { svg: new XMLSerializer().serializeToString(clone), width, height, background };
    }

    private getSvgSize(svg: SVGSVGElement): [number, number] {
        const viewBox = svg.getAttribute("viewBox")?.split(/\s+/).map(Number);
        if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite)) {
            return [Math.ceil(viewBox[2]), Math.ceil(viewBox[3])];
        }
        return [Math.ceil(svg.clientWidth), Math.ceil(svg.clientHeight)];
    }

    private inlineSvgStyles(source: Element, clone: Element): void {
        const computed = getComputedStyle(source);
        const properties = [
            "fill", "stroke", "stroke-width", "stroke-dasharray", "opacity",
            "font-family", "font-size", "font-weight", "text-anchor", "filter"
        ];
        clone.setAttribute("style", properties.map((property) => `${property}:${computed.getPropertyValue(property)}`).join(";"));
        Array.from(source.children).forEach((child, index) => {
            const cloneChild = clone.children.item(index);
            if (cloneChild) this.inlineSvgStyles(child, cloneChild);
        });
    }

    private createPdfFromJpeg(dataUrl: string, width: number, height: number): Blob {
        const image = this.base64ToBytes(dataUrl.split(",")[1] ?? "");
        const pageWidth = width * 0.75;
        const pageHeight = height * 0.75;
        const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;
        const encoder = new TextEncoder();
        const chunks: BlobPart[] = [];
        const offsets: number[] = [0];
        let offset = 0;
        const add = (chunk: string | Uint8Array): void => {
            const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
            chunks.push(Uint8Array.from(bytes).buffer);
            offset += bytes.length;
        };
        const object = (number: number, body: string): void => {
            offsets[number] = offset;
            add(`${number} 0 obj\n${body}\nendobj\n`);
        };

        add("%PDF-1.4\n");
        object(1, "<< /Type /Catalog /Pages 2 0 R >>");
        object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
        offsets[4] = offset;
        add(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`);
        add(image);
        add("\nendstream\nendobj\n");
        object(5, `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`);

        const xref = offset;
        add(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((entry) => `${(`0000000000${entry}`).slice(-10)} 00000 n `).join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
        return new Blob(chunks, { type: "application/pdf" });
    }

    private base64ToBytes(base64: string): Uint8Array {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    }

    private downloadBlob(blob: Blob, filename: string): void {
        const url = URL.createObjectURL(blob);
        const link = activeDocument.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }

    private getDownloadBaseName(): string {
        const name = this.file?.path?.split("/").pop()?.replace(/\.md$/i, "") || "mind-map";
        return [...name].map((character) => '<>:"/\\|?*'.includes(character) || character.charCodeAt(0) < 32 ? "-" : character).join("").trim() || "mind-map";
    }

    private openNodeMenu(nodeId: string, event: MouseEvent): void {
        if (!this.data) return;

        const node = findNode(this.data.root, nodeId);
        if (!node) return;

        this.selectNode(nodeId, false);
        this.render();

        const menu = new Menu();
        menu.addItem((item) => {
            item
                .setTitle("Edit label")
                .setIcon("pencil")
                .onClick(() => this.renameNode(nodeId));
        });
        menu.addItem((item) => {
            item
                .setTitle(node.note ? "Edit note" : "Add note")
                .setIcon("sticky-note")
                .onClick(() => this.editNodeNote(nodeId));
        });
        menu.addItem((item) => {
            item
                .setTitle(node.linkedFilePath ? "Open linked note" : "New linked note")
                .setIcon("file-text")
                .onClick(() => {
                    void this.openOrCreateLinkedNote(nodeId);
                });
        });
        if (node.linkedFilePath) {
            menu.addItem((item) => {
                item
                    .setTitle("Remove linked note")
                    .setIcon("unlink")
                    .onClick(() => this.clearLinkedNote(nodeId));
            });
        }
        menu.addSeparator();
        menu.addItem((item) => {
            item
                .setTitle("Delete")
                .setIcon("trash")
                .onClick(() => this.deleteNode(nodeId));
        });

        menu.showAtMouseEvent(event);
    }

    private editNodeNote(nodeId: string): void {
        if (!this.data) return;

        const node = findNode(this.data.root, nodeId);
        if (!node) return;

        new NodeNoteModal(this.app, node.content, node.note ?? "", (note) => {
            this.runCommand("Edit node note", () => {
                if (!this.data) return false;
                const current = findNode(this.data.root, nodeId);
                if (!current) return false;
                const trimmed = note.trim();
                if (trimmed) {
                    current.note = trimmed;
                } else {
                    delete current.note;
                }
                this.state.selectedNodeId = nodeId;
                this.selectedNodeIds = new Set([nodeId]);
                this.connectSourceId = null;
                this.mergeSourceId = null;
                this.editingNodeId = null;
            });
        }).open();
    }

    private async openOrCreateLinkedNote(nodeId: string): Promise<void> {
        if (!this.data) return;

        const node = findNode(this.data.root, nodeId);
        if (!node) return;

        if (node.linkedFilePath) {
            await this.openLinkedFile(node.linkedFilePath);
            return;
        }

        const filePath = await this.createLinkedNoteFile(node);
        this.runCommand("Link node note", () => {
            if (!this.data) return false;
            const current = findNode(this.data.root, nodeId);
            if (!current) return false;
            current.linkedFilePath = filePath;
            this.state.selectedNodeId = nodeId;
            this.selectedNodeIds = new Set([nodeId]);
            this.connectSourceId = null;
            this.mergeSourceId = null;
            this.editingNodeId = null;
        });
        await this.openLinkedFile(filePath);
    }

    private async createLinkedNoteFile(node: MindMapNode): Promise<string> {
        const activeFile = this.file || this.app.workspace.getActiveFile();
        const dir = activeFile instanceof TFile ? activeFile.parent?.path : undefined;
        const baseName = this.slugifyFileName(node.content || "Node note");
        const basePath = normalizePath(dir ? `${dir}/${baseName}` : baseName);
        const filePath = await this.getAvailableMarkdownPath(basePath);
        const body = [
            `# ${node.content}`,
            "",
            node.note ? node.note : ""
        ].join("\n");

        await this.app.vault.create(filePath, body);
        return filePath;
    }

    private async openLinkedFile(filePath: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            await this.app.workspace.getLeaf("tab").openFile(file);
        } else {
            new Notice(`Linked note not found: ${filePath}`);
        }
    }

    private clearLinkedNote(nodeId: string): void {
        this.runCommand("Remove linked note", () => {
            if (!this.data) return false;
            const node = findNode(this.data.root, nodeId);
            if (!node || !node.linkedFilePath) return false;
            delete node.linkedFilePath;
            this.state.selectedNodeId = nodeId;
            this.selectedNodeIds = new Set([nodeId]);
        });
    }

    private slugifyFileName(text: string): string {
        const slug = text
            .trim()
            .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
            .replace(/\s+/g, " ")
            .slice(0, 80)
            .trim();
        return slug || "Node note";
    }

    private addChildNode(parentNodeId: string | null = this.state.selectedNodeId): void {
        if (!this.data || !parentNodeId) {
            new Notice("Select a node before adding a child.");
            return;
        }

        const parent = findNode(this.data.root, parentNodeId);
        if (!parent) {
            new Notice("Selected node was not found.");
            return;
        }

        const newNode = createNode("New node", this.getChildPosition(parent));
        this.runCommand("Add child", () => {
            if (!this.data) return false;
            if (!addTreeChildNode(this.data.root, parentNodeId, newNode)) return false;
            this.state.selectedNodeId = newNode.id;
            this.selectedNodeIds = new Set([newNode.id]);
            this.connectSourceId = null;
            this.mergeSourceId = null;
            this.editingNodeId = newNode.id;
        });
    }

    private addSiblingNode(): void {
        if (!this.data || !this.state.selectedNodeId) {
            new Notice("Select a node before adding a sibling.");
            return;
        }
        if (this.state.selectedNodeId === this.data.root.id) {
            new Notice("The central node cannot have a sibling. Add a child instead.");
            return;
        }

        const newNode = createNode("New node", this.getSiblingPosition(this.state.selectedNodeId));
        this.runCommand("Add sibling", () => {
            if (!this.data || !this.state.selectedNodeId) return false;
            if (!addTreeSiblingNode(this.data.root, this.state.selectedNodeId, newNode)) return false;
            this.state.selectedNodeId = newNode.id;
            this.selectedNodeIds = new Set([newNode.id]);
            this.connectSourceId = null;
            this.mergeSourceId = null;
            this.editingNodeId = newNode.id;
        });
    }

    private renameNode(nodeId: string | null = this.state.selectedNodeId): void {
        if (!this.data || !nodeId) {
            new Notice("Select a node to rename.");
            return;
        }

        const node = findNode(this.data.root, nodeId);
        if (!node) {
            new Notice("Selected node was not found.");
            return;
        }

        this.state.selectedNodeId = node.id;
        this.selectedNodeIds = new Set([node.id]);
        this.connectSourceId = null;
        this.mergeSourceId = null;
        this.editingNodeId = node.id;
        this.render();
    }

    private commitInlineRename(nodeId: string, content: string): void {
        if (!this.data) return;

        const node = findNode(this.data.root, nodeId);
        const trimmed = content.trim();
        this.editingNodeId = null;
        if (!node || !trimmed || trimmed === node.content) {
            this.render();
            return;
        }

        this.runCommand("Rename node", () => {
            if (!this.data) return false;
            if (!renameTreeNode(this.data.root, nodeId, trimmed)) return false;
            this.state.selectedNodeId = nodeId;
            this.selectedNodeIds = new Set([nodeId]);
            this.connectSourceId = null;
            this.mergeSourceId = null;
        });
    }

    private startConnect(): void {
        if (!this.data || !this.state.selectedNodeId) {
            new Notice("Select a source node first.");
            return;
        }

        if (this.connectSourceId === this.state.selectedNodeId) {
            this.connectSourceId = null;
            this.render();
            return;
        }

        this.connectSourceId = this.state.selectedNodeId;
        this.mergeSourceId = null;
        this.editingNodeId = null;
        this.render();
    }

    private startMerge(): void {
        if (!this.data || !this.state.selectedNodeId) {
            new Notice("Select a source node first.");
            return;
        }
        if (this.state.selectedNodeId === this.data.root.id) {
            new Notice("The central node cannot be merged. Merge sibling child nodes instead.");
            return;
        }

        if (this.mergeSourceId === this.state.selectedNodeId) {
            this.mergeSourceId = null;
            this.render();
            return;
        }

        this.mergeSourceId = this.state.selectedNodeId;
        this.connectSourceId = null;
        this.editingNodeId = null;
        this.render();
    }

    private groupSelectedNodes(): void {
        if (!this.data || this.selectedNodeIds.size < 2) {
            new Notice("Select at least two sibling nodes to group.");
            return;
        }

        const refs = Array.from(this.selectedNodeIds)
            .map((id) => ({ id, ref: findChildRef(this.data!.root, id) }))
            .filter((entry): entry is { id: string; ref: { parent: MindMapNode; index: number } } => entry.ref !== null);
        if (refs.length < 2) {
            new Notice("Select at least two non-central sibling nodes to group.");
            return;
        }

        const parent = refs[0].ref.parent;
        if (!refs.every((entry) => entry.ref.parent === parent)) {
            new Notice("Select sibling nodes under the same parent to group.");
            return;
        }

        const ordered = refs
            .sort((a, b) => a.ref.index - b.ref.index)
            .map((entry) => parent.children[entry.ref.index]);
        const defaultName = ordered.map((node) => node.content).join(" + ");

        new TextInputModal(this.app, "Group node name", defaultName, (groupName) => {
            this.runCommand("Group nodes", () => {
                if (!this.data) return false;
                const groupNode = groupSiblingNodes(
                    this.data.root,
                    refs.map((entry) => entry.id),
                    groupName.trim() || defaultName,
                    getGroupPosition(ordered[0], ordered[ordered.length - 1])
                );
                if (!groupNode) return false;
                this.state.selectedNodeId = groupNode.id;
                this.selectedNodeIds = new Set([groupNode.id]);
                this.connectSourceId = null;
                this.mergeSourceId = null;
            });
        }).open();
    }

    private autoLayout(): void {
        if (!this.data) return;

        this.runCommand("Auto layout", () => {
            if (!this.data) return false;
            clearPositions(this.data.root);
            this.connectSourceId = null;
            this.mergeSourceId = null;
            this.editingNodeId = null;
        });
    }

    private moveNode(nodeId: string, position: LayoutPosition): void {
        if (!this.data) return;

        const node = findNode(this.data.root, nodeId);
        if (!node) return;

        this.runCommand("Move node", () => {
            if (!this.data) return false;
            if (!moveTreeNode(this.data.root, nodeId, position)) return false;
            this.state.selectedNodeId = nodeId;
            this.selectedNodeIds = new Set([nodeId]);
            this.editingNodeId = null;
        });
    }

    private dropNode(nodeId: string, targetNodeId: string | null, position: LayoutPosition, merge: boolean): void {
        if (!this.data || !targetNodeId) {
            this.moveNode(nodeId, position);
            return;
        }

        if (merge) {
            if (!this.mergeNodes(nodeId, targetNodeId)) {
                this.moveNode(nodeId, position);
            }
            return;
        }

        if (!this.runCommand("Reparent node", () => {
            if (!this.data) return false;
            if (!reparentTreeNode(this.data.root, nodeId, targetNodeId, position)) return false;
            this.state.selectedNodeId = nodeId;
            this.selectedNodeIds = new Set([nodeId]);
            this.connectSourceId = null;
            this.mergeSourceId = null;
            this.editingNodeId = null;
        })) {
            this.moveNode(nodeId, position);
        }
    }

    private connectNodes(fromNodeId: string, toNodeId: string): void {
        if (!this.data) return;
        if (fromNodeId === toNodeId) {
            this.connectSourceId = null;
            this.render();
            return;
        }

        const fromNode = findNode(this.data.root, fromNodeId);
        const toNode = findNode(this.data.root, toNodeId);
        if (!fromNode || !toNode) {
            new Notice("Could not connect these nodes.");
            return;
        }

        if (!this.runCommand("Connect nodes", () => {
            if (!this.data) return false;
            const connections = this.data.connections ?? [];
            const exists = connections.some((connection) =>
                connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId
            );
            if (exists) {
                return false;
            }

            this.data.connections = [
                ...connections,
                {
                    id: crypto.randomUUID(),
                    fromNodeId,
                    toNodeId
                }
            ];
            this.state.selectedNodeId = toNodeId;
            this.selectedNodeIds = new Set([toNodeId]);
            this.connectSourceId = null;
            this.mergeSourceId = null;
            this.editingNodeId = null;
        })) {
            new Notice("These nodes are already connected.");
            this.connectSourceId = null;
            this.render();
        }
    }

    private mergeNodes(sourceNodeId: string, targetNodeId: string): boolean {
        if (!this.data || sourceNodeId === targetNodeId) return false;
        if (sourceNodeId === this.data.root.id) return false;
        if (targetNodeId === this.data.root.id) return false;

        const sourceRef = findChildRef(this.data.root, sourceNodeId);
        const targetRef = findChildRef(this.data.root, targetNodeId);
        if (!sourceRef || !targetRef || sourceRef.parent !== targetRef.parent) {
            new Notice("Merge only works for sibling nodes under the same parent.");
            return false;
        }

        const parent = sourceRef.parent;
        const firstIndex = Math.min(sourceRef.index, targetRef.index);
        const secondIndex = Math.max(sourceRef.index, targetRef.index);
        const firstNode = parent.children[firstIndex];
        const secondNode = parent.children[secondIndex];
        const position = getGroupPosition(firstNode, secondNode);
        const defaultGroupName = this.getDefaultGroupName(firstNode, secondNode);
        new TextInputModal(this.app, "Merged node name", defaultGroupName, (groupName) => {
            this.runCommand("Merge nodes", () => {
                if (!this.data) return false;
                const groupNode = groupSiblingNodes(
                    this.data.root,
                    [firstNode.id, secondNode.id],
                    groupName.trim() || defaultGroupName,
                    position
                );
                if (!groupNode) return false;
                this.state.selectedNodeId = groupNode.id;
                this.selectedNodeIds = new Set([groupNode.id]);
                this.connectSourceId = null;
                this.mergeSourceId = null;
                this.editingNodeId = null;
            });
        }).open();
        return true;
    }

    private deleteNode(nodeId: string | null = this.state.selectedNodeId): void {
        if (!this.data || !nodeId) {
            new Notice("Select a node to delete.");
            return;
        }

        if (nodeId === this.data.root.id) {
            new Notice("The central node cannot be deleted.");
            return;
        }
        const node = findNode(this.data.root, nodeId);
        if (!node) {
            new Notice("Selected node was not found.");
            return;
        }

        if (node.children.length > 0) {
            new ConfirmModal(
                this.app,
                "Delete node",
                `Delete "${node.content}" and all child nodes?`,
                () => this.deleteNodeNow(nodeId)
            ).open();
            return;
        }

        this.deleteNodeNow(nodeId);
    }

    private deleteNodeNow(nodeId: string): void {
        if (!this.data || nodeId === this.data.root.id) return;

        const parent = findParent(this.data.root, nodeId);
        if (parent) {
            this.runCommand("Delete node", () => {
                if (!this.data) return false;
                if (!deleteTreeNode(this.data.root, nodeId)) return false;
                this.removeConnectionsForNode(nodeId);
                this.state.selectedNodeId = parent.id;
                this.selectedNodeIds = new Set([parent.id]);
                this.connectSourceId = null;
                this.mergeSourceId = null;
                this.editingNodeId = null;
            });
        }
    }

    private removeConnectionsForNode(nodeId: string): void {
        if (!this.data?.connections) return;

        this.data.connections = this.data.connections.filter((connection) =>
            connection.fromNodeId !== nodeId && connection.toNodeId !== nodeId
        );
    }

    private toggleCollapse(nodeId: string | null = this.state.selectedNodeId): void {
        if (!this.data || !nodeId) {
            new Notice("Select a node to collapse or expand.");
            return;
        }

        const node = findNode(this.data.root, nodeId);
        if (node && node.children.length > 0) {
            this.runCommand("Toggle collapse", () => {
                if (!this.data) return false;
                if (!toggleTreeCollapse(this.data.root, nodeId)) return false;
                this.state.selectedNodeId = node.id;
                this.selectedNodeIds = new Set([node.id]);
                this.connectSourceId = null;
                this.mergeSourceId = null;
                this.editingNodeId = null;
            });
        } else {
            new Notice("Only nodes with children can collapse or expand.");
        }
    }

    private getChildPosition(parent: MindMapNode): LayoutPosition {
        const base = parent.position ?? { x: 160, y: 72 };
        return {
            x: base.x + 240,
            y: base.y + Math.max(parent.children.length, 0) * 88
        };
    }

    private getSiblingPosition(nodeId: string): LayoutPosition {
        const node = this.data ? findNode(this.data.root, nodeId) : null;
        const base = node?.position ?? { x: 160, y: 72 };
        return {
            x: base.x,
            y: base.y + 88
        };
    }

    private getDefaultGroupName(firstNode: MindMapNode, secondNode: MindMapNode): string {
        return `${firstNode.content} + ${secondNode.content}`;
    }

    private renderMinimap(): void {
        if (!this.data || !this.minimapEl) return;

        const root = this.data.root;
        const positions = layoutTree(root);
        const visibleNodes = this.getVisibleNodes(root);
        for (const node of visibleNodes) {
            if (node.position) positions.set(node.id, node.position);
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const node of visibleNodes) {
            const pos = positions.get(node.id);
            if (!pos) continue;
            minX = Math.min(minX, pos.x - 80);
            minY = Math.min(minY, pos.y);
            maxX = Math.max(maxX, pos.x + 80);
            maxY = Math.max(maxY, pos.y + 48);
        }

        if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

        const width = 180;
        const height = 120;
        const mapWidth = Math.max(1, maxX - minX);
        const mapHeight = Math.max(1, maxY - minY);
        const scale = Math.min((width - 16) / mapWidth, (height - 16) / mapHeight);
        const tx = 8 - minX * scale;
        const ty = 8 - minY * scale;

        this.minimapEl.empty();
        const svg = activeDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        svg.setAttribute("class", "mindmap-minimap-svg");

        const drawNode = (node: MindMapNode): void => {
            const from = positions.get(node.id);
            if (!from) return;
            if (!node.collapsed) {
                for (const child of node.children) {
                    const to = positions.get(child.id);
                    if (to) {
                        const line = activeDocument.createElementNS("http://www.w3.org/2000/svg", "line");
                        line.setAttribute("x1", String(from.x * scale + tx));
                        line.setAttribute("y1", String((from.y + 24) * scale + ty));
                        line.setAttribute("x2", String(to.x * scale + tx));
                        line.setAttribute("y2", String((to.y + 24) * scale + ty));
                        line.setAttribute("class", "mindmap-minimap-edge");
                        svg.appendChild(line);
                    }
                    drawNode(child);
                }
            }

            const rect = activeDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", String((from.x - 80) * scale + tx));
            rect.setAttribute("y", String(from.y * scale + ty));
            rect.setAttribute("width", String(160 * scale));
            rect.setAttribute("height", String(48 * scale));
            rect.setAttribute("rx", "2");
            rect.setAttribute("class", this.selectedNodeIds.has(node.id) ? "mindmap-minimap-node is-selected" : "mindmap-minimap-node");
            svg.appendChild(rect);
        };

        drawNode(root);

        const viewport = this.canvas?.getViewportSize();
        if (viewport) {
            const rect = activeDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", String((-this.state.pan.x) * scale + tx));
            rect.setAttribute("y", String((-this.state.pan.y) * scale + ty));
            rect.setAttribute("width", String((viewport.width / this.state.zoom) * scale));
            rect.setAttribute("height", String((viewport.height / this.state.zoom) * scale));
            rect.setAttribute("class", "mindmap-minimap-viewport");
            svg.appendChild(rect);
        }

        this.minimapEl.appendChild(svg);
    }

    private getVisibleNodes(root: MindMapNode): MindMapNode[] {
        const nodes: MindMapNode[] = [];
        const visit = (node: MindMapNode): void => {
            nodes.push(node);
            if (!node.collapsed) node.children.forEach(visit);
        };
        visit(root);
        return nodes;
    }

    private setupSpacePanHandlers(): void {
        this.registerDomEvent(window, "keydown", (event: KeyboardEvent) => {
            if (event.code === "Space" && !this.isTextInputTarget(event.target)) {
                this.isSpacePanPressed = true;
            }
        });
        this.registerDomEvent(window, "keyup", (event: KeyboardEvent) => {
            if (event.code === "Space") {
                this.isSpacePanPressed = false;
                this.containerEl.querySelector(".mindmap-canvas")?.removeClass("is-space-pan");
            }
        });
    }

}

class TextInputModal extends Modal {
    constructor(
        app: App,
        private title: string,
        private initialValue: string,
        private onSubmit: (value: string) => void
    ) {
        super(app);
    }

    onOpen(): void {
        this.setTitle(this.title);
        this.contentEl.empty();
        this.contentEl.addClass("mindmap-text-modal");

        const input = this.contentEl.createEl("input", {
            type: "text",
            value: this.initialValue
        });
        input.addClass("mindmap-text-modal-input");

        const buttons = this.contentEl.createDiv("mindmap-text-modal-buttons");
        const cancelButton = buttons.createEl("button", { text: "Cancel" });
        const saveButton = buttons.createEl("button", { text: "Save" });
        saveButton.addClass("mod-cta");

        const submit = (): void => {
            this.onSubmit(input.value);
            this.close();
        };

        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                submit();
            }
            if (event.key === "Escape") {
                event.preventDefault();
                this.close();
            }
        });
        cancelButton.addEventListener("click", () => this.close());
        saveButton.addEventListener("click", submit);

        window.setTimeout(() => {
            input.focus();
            input.select();
        }, 0);
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

class NodeNoteModal extends Modal {
    constructor(
        app: App,
        private nodeTitle: string,
        private initialValue: string,
        private onSubmit: (value: string) => void
    ) {
        super(app);
    }

    onOpen(): void {
        this.setTitle(`Node note: ${this.nodeTitle}`);
        this.modalEl.addClass("mindmap-node-note-modal-shell");
        this.contentEl.empty();
        this.contentEl.addClass("mindmap-node-note-modal");

        const textarea = this.contentEl.createEl("textarea");
        textarea.addClass("mindmap-node-note-textarea");
        textarea.value = this.initialValue;

        const buttons = this.contentEl.createDiv("mindmap-text-modal-buttons");
        const clearButton = buttons.createEl("button", { text: "Clear" });
        const cancelButton = buttons.createEl("button", { text: "Cancel" });
        const saveButton = buttons.createEl("button", { text: "Save" });
        saveButton.addClass("mod-cta");

        clearButton.addEventListener("click", () => {
            textarea.value = "";
            textarea.focus();
        });
        cancelButton.addEventListener("click", () => this.close());
        saveButton.addEventListener("click", () => {
            this.onSubmit(textarea.value);
            this.close();
        });
        textarea.addEventListener("keydown", (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                this.onSubmit(textarea.value);
                this.close();
            }
            if (event.key === "Escape") {
                event.preventDefault();
                this.close();
            }
        });

        window.setTimeout(() => {
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        }, 0);
    }

    onClose(): void {
        this.modalEl.removeClass("mindmap-node-note-modal-shell");
        this.contentEl.empty();
    }
}

class GuideModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen(): void {
        this.setTitle("Mind Map Guide");
        this.contentEl.empty();
        this.contentEl.addClass("mindmap-guide-modal");

        this.addSection("Toolbar buttons", [
            ["Zoom - / Zoom +", "Change map zoom."],
            ["100%", "Reset zoom to default."],
            ["Fit", "Fit the full map into the current view."],
            ["Undo / Redo", "Step backward or forward through map edits."],
            ["Add child", "Create a child under the selected node."],
            ["Add sibling", "Create a sibling next to the selected node."],
            ["Rename", "Start inline rename for the selected node."],
            ["Connect", "Select a source node, click Connect, then click a target node to add a dashed cross-link without changing the tree."],
            ["Merge", "Select one sibling, click Merge, then click another sibling to create one grouped node."],
            ["Group", "Group two or more selected sibling nodes into one parent node."],
            ["Auto layout", "Clear manual node positions and rebuild the tree layout."],
            ["Delete", "Delete the selected node. The central node is protected."],
            ["Save", "Write the current mind map to the Obsidian note."],
            ["Download", "Export the full mind map as PNG, JPEG, or PDF."]
        ]);

        this.addSection("Open a saved mind map", [
            ["1", "Open the saved mind map Markdown note in Obsidian."],
            ["2", "Open the Command palette with Cmd/Ctrl + P."],
            ["3", "Run “Mind map: Open current file as mind map”."]
        ]);

        this.addSection("Node gestures", [
            ["Click", "Select a node."],
            ["Shift + click", "Add or remove a node from the current selection."],
            ["Double-click", "Rename a node inline."],
            ["Drag node", "Move a node."],
            ["Drag node onto another node", "Move it under the target node."],
            ["Shift + drag node onto sibling", "Merge with the drop target when possible."],
            ["Right-click node", "Open node actions: edit label, edit long note, create/open linked note, delete."],
            ["+ handle", "Add a child node."],
            ["- / + left handle", "Collapse or expand child nodes."],
            ["x handle", "Delete a node."]
        ]);

        this.addSection("Canvas gestures", [
            ["Mouse wheel", "Zoom in or out."],
            ["Drag empty canvas", "Pan the map."],
            ["Middle mouse drag", "Pan the map."],
            ["Hold Space + drag", "Pan the map from anywhere."],
            ["Shift + drag empty canvas", "Draw a box to multi-select nodes."]
        ]);

        this.addSection("Hotkeys", [
            ["Tab", "Add child."],
            ["Enter", "Add sibling."],
            ["F2", "Rename selected node."],
            ["Delete / Backspace", "Delete selected node."],
            ["Cmd/Ctrl + Z", "Undo."],
            ["Cmd/Ctrl + Shift + Z", "Redo."],
            ["Cmd/Ctrl + S", "Save."],
            ["Cmd/Ctrl + +", "Zoom in and center the selected node."],
            ["Cmd/Ctrl + -", "Zoom out and center the selected node."],
            ["Cmd/Ctrl + 0", "Reset zoom to 100%."],
            ["Cmd/Ctrl + /", "Open this guide."]
        ]);
    }

    private addSection(title: string, rows: Array<[string, string]>): void {
        this.contentEl.createEl("h3", { text: title });
        const table = this.contentEl.createEl("table");
        table.addClass("mindmap-guide-table");
        const tbody = table.createEl("tbody");

        for (const [name, description] of rows) {
            const row = tbody.createEl("tr");
            row.createEl("th", { text: name });
            row.createEl("td", { text: description });
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

class ConfirmModal extends Modal {
    constructor(
        app: App,
        private title: string,
        private message: string,
        private onConfirm: () => void
    ) {
        super(app);
    }

    onOpen(): void {
        this.setTitle(this.title);
        this.contentEl.empty();
        this.contentEl.addClass("mindmap-confirm-modal");
        this.contentEl.createEl("p", { text: this.message });

        const buttons = this.contentEl.createDiv("mindmap-text-modal-buttons");
        const cancelButton = buttons.createEl("button", { text: "Cancel" });
        const confirmButton = buttons.createEl("button", { text: "Delete" });
        confirmButton.addClass("mod-warning");

        cancelButton.addEventListener("click", () => this.close());
        confirmButton.addEventListener("click", () => {
            this.onConfirm();
            this.close();
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
