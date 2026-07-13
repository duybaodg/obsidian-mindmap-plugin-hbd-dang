import { MindMapData } from "./models";
import { cloneMindMap } from "./tree";

export interface MindMapCommand {
    label: string;
    before: MindMapData;
    after: MindMapData;
}

export class CommandHistory {
    private undoStack: MindMapCommand[] = [];
    private redoStack: MindMapCommand[] = [];

    execute(label: string, data: MindMapData, mutate: () => boolean | void): MindMapCommand | null {
        const before = cloneMindMap(data);
        const result = mutate();
        if (result === false) return null;

        const after = cloneMindMap(data);
        const command: MindMapCommand = { label, before, after };
        this.undoStack.push(command);
        if (this.undoStack.length > 100) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        return command;
    }

    undo(): MindMapData | null {
        const command = this.undoStack.pop();
        if (!command) return null;

        this.redoStack.push(command);
        return cloneMindMap(command.before);
    }

    redo(): MindMapData | null {
        const command = this.redoStack.pop();
        if (!command) return null;

        this.undoStack.push(command);
        return cloneMindMap(command.after);
    }

    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
    }
}
