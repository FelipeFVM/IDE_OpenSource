/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';
import { aiProviderIds, AiSettings, defaultAiHostConfiguration } from '../../../../platform/aiHost/common/aiHost.js';
import { AiChatViewPane } from './aiChatView.js';
import './aiAssistantActions.js';
import './aiEditorContextService.js';

export const AI_ASSISTANT_VIEWLET_ID = 'workbench.view.aiAssistant';

const aiAssistantViewIcon = registerIcon('ai-assistant-view-icon', Codicon.sparkle, localize('aiAssistantViewIcon', "View icon of the AI assistant view."));

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: AI_ASSISTANT_VIEWLET_ID,
	title: localize2('aiAssistant', "AI Assistant"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AI_ASSISTANT_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: aiAssistantViewIcon,
	storageId: 'workbench.aiAssistant.views.state',
	order: 5,
	openCommandActionDescriptor: {
		id: AI_ASSISTANT_VIEWLET_ID,
		mnemonicTitle: localize({ key: 'miViewAiAssistant', comment: ['&& denotes a mnemonic'] }, "&&AI Assistant"),
		order: 5,
	},
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: AiChatViewPane.ID,
	name: localize2('aiChat', "Chat"),
	containerIcon: aiAssistantViewIcon,
	ctorDescriptor: new SyncDescriptor(AiChatViewPane),
	canToggleVisibility: false,
	canMoveView: true,
}], viewContainer);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: AiSettings.section,
	title: localize('aiAssistantConfigurationTitle', "AI Assistant"),
	type: 'object',
	properties: {
		[AiSettings.provider]: {
			type: 'string',
			enum: [...aiProviderIds],
			enumDescriptions: [
				localize('aiAssistant.provider.anthropic', "Claude models through the Anthropic API."),
				localize('aiAssistant.provider.echo', "Offline test provider that echoes the prompt and editor context."),
			],
			default: defaultAiHostConfiguration.provider,
			description: localize('aiAssistant.provider', "The model provider used by the AI Assistant."),
		},
		[AiSettings.model]: {
			type: 'string',
			default: defaultAiHostConfiguration.model,
			description: localize('aiAssistant.model', "The Anthropic model ID used by the AI Assistant, for example claude-sonnet-5-5 or claude-opus-5-5."),
		},
		[AiSettings.effort]: {
			type: 'string',
			enum: ['low', 'medium', 'high', 'max'],
			default: defaultAiHostConfiguration.effort,
			description: localize('aiAssistant.effort', "How much effort the model spends on each reply. Higher levels think longer and cost more."),
		},
	},
});

// Our assistant replaces the built-in chat: turn off the upstream chat UI and
// Agent Host by default, and keep the secondary side bar (where the upstream
// chat lives) closed. Users can still opt back in through these settings.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		[ChatAIDisabledSettingId]: true,
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
	},
}]);
