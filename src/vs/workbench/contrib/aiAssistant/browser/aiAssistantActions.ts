/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { aiAnthropicApiKeySecret } from '../../../../platform/aiHost/common/aiHost.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { ViewAction } from '../../../browser/parts/views/viewPane.js';
import { AiChatViewPane } from './aiChatView.js';

const category = localize2('aiAssistant.category', "AI Assistant");

registerAction2(class SetAnthropicApiKeyAction extends Action2 {
	constructor() {
		super({
			id: 'aiAssistant.setAnthropicApiKey',
			title: localize2('aiAssistant.setApiKey', "Set Anthropic API Key"),
			category,
			f1: true,
			icon: Codicon.key,
			menu: {
				id: MenuId.ViewTitle,
				group: 'secondary',
				when: ContextKeyExpr.equals('view', AiChatViewPane.ID),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const secretStorageService = accessor.get(ISecretStorageService);
		const notificationService = accessor.get(INotificationService);

		const key = await quickInputService.input({
			title: localize('aiAssistant.setApiKey.title', "Anthropic API Key"),
			prompt: localize('aiAssistant.setApiKey.prompt', "The key is stored in the operating system's secure storage."),
			placeHolder: 'sk-ant-…',
			password: true,
			ignoreFocusLost: true,
			validateInput: async value => value.trim() ? undefined : localize('aiAssistant.setApiKey.empty', "Enter an API key."),
		});
		if (!key?.trim()) {
			return;
		}
		await secretStorageService.set(aiAnthropicApiKeySecret, key.trim());
		notificationService.info(localize('aiAssistant.setApiKey.done', "Anthropic API key saved."));
	}
});

registerAction2(class ClearAnthropicApiKeyAction extends Action2 {
	constructor() {
		super({
			id: 'aiAssistant.clearAnthropicApiKey',
			title: localize2('aiAssistant.clearApiKey', "Clear Anthropic API Key"),
			category,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const secretStorageService = accessor.get(ISecretStorageService);
		const notificationService = accessor.get(INotificationService);
		await secretStorageService.delete(aiAnthropicApiKeySecret);
		notificationService.info(localize('aiAssistant.clearApiKey.done', "Anthropic API key removed."));
	}
});

registerAction2(class NewChatAction extends ViewAction<AiChatViewPane> {
	constructor() {
		super({
			id: 'aiAssistant.newChat',
			title: localize2('aiAssistant.newChat', "New Chat"),
			category,
			icon: Codicon.add,
			viewId: AiChatViewPane.ID,
			f1: true,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				when: ContextKeyExpr.equals('view', AiChatViewPane.ID),
			},
		});
	}

	runInView(_accessor: ServicesAccessor, view: AiChatViewPane): void {
		view.newChat();
	}
});
