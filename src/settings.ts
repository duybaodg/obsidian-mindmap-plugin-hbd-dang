import { PluginSettingTab, App, Plugin, Setting } from "obsidian";

export class MindMapSettingTab extends PluginSettingTab {
    constructor(app: App, plugin: Plugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl).setName('Mind Map').setHeading();

        containerEl.createEl('p', {
            text: 'Additional settings will be added in future versions.'
        });
    }
}
