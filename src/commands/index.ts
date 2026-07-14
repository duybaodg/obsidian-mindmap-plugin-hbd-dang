import { App, Plugin } from "obsidian";
import { MindMapView, VIEW_TYPE } from "../mindmap/view";

export function registerCommands(app: App, plugin: Plugin): void {
    plugin.addCommand({
        id: "obsidian-mindmap-create",
        name: "Mind map: Create new mind map",
        callback: async () => {
            const leaf = app.workspace.getLeaf("tab");
            await leaf.setViewState({ type: VIEW_TYPE, active: true });

            const view = leaf.view as MindMapView;
            if (view instanceof MindMapView) {
                view.createNew();
            }
        }
    });

    plugin.addCommand({
        id: "obsidian-mindmap-open",
        name: "Mind map: Open current file as mind map",
        checkCallback: (checking: boolean) => {
            const activeFile = app.workspace.getActiveFile();
            if (!activeFile) return false;

            if (!checking) {
                void (async () => {
                    const leaf = app.workspace.getLeaf("tab");
                    await leaf.setViewState({ type: VIEW_TYPE, active: true });

                    const view = leaf.view as MindMapView;
                    if (view instanceof MindMapView) {
                        await view.loadFile(activeFile.path);
                    }
                })();
            }

            return true;
        }
    });

    plugin.addCommand({
        id: "obsidian-mindmap-save",
        name: "Mind map: Save current mind map",
        checkCallback: (checking: boolean) => {
            const view = app.workspace.getActiveViewOfType(MindMapView);
            if (!view) {
                return false;
            }

            if (!checking) {
                void view.save();
            }

            return true;
        }
    });
}
