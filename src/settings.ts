import { PluginSettingTab, App, Plugin } from "obsidian";

export class MindMapSettingTab extends PluginSettingTab {
    constructor(app: App, plugin: Plugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Mind Map Settings' });

        containerEl.createEl('p', {
            text: 'Additional settings will be added in future versions.'
        });
    }
}
