/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const aiHostChannelName = 'aiHost';

/**
 * Module loaded into the AI host utility process. Also listed as a desktop
 * entry point in `build/next/index.ts` so that it is bundled for production.
 */
export const aiHostModuleId = 'vs/platform/aiHost/node/aiHostMain';

export interface IAiPosition {
	readonly lineNumber: number;
	readonly column: number;
}

export interface IAiRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

/**
 * Snapshot of the active editor at the moment a request is sent.
 * Plain data only, so it can cross the message port unchanged.
 */
export interface IAiEditorContext {
	readonly uri: string;
	readonly fileName: string;
	readonly languageId: string;
	readonly versionId: number;
	readonly lineCount: number;
	readonly cursor: IAiPosition | undefined;
	readonly selections: readonly IAiRange[];
	readonly selectedText: string;
	/** Full model text, capped at {@link aiMaxContentLength} characters. */
	readonly content: string;
	readonly contentTruncated: boolean;
}

export const aiMaxContentLength = 200_000;

export interface IAiChatRequest {
	readonly requestId: string;
	/**
	 * Conversation the request belongs to. The AI host keeps each
	 * conversation's history, so only the new turn crosses the message port.
	 */
	readonly conversationId: string;
	readonly prompt: string;
	readonly context: IAiEditorContext | undefined;
}

export type AiEffort = 'low' | 'medium' | 'high' | 'max';

export const aiProviderIds = ['anthropic', 'echo'] as const;
export type AiProviderId = typeof aiProviderIds[number];

export interface IAiHostConfiguration {
	readonly provider: string;
	readonly model: string;
	readonly effort: AiEffort;
	/**
	 * Anthropic API key from secret storage. When undefined, the SDK falls
	 * back to its own credential resolution (e.g. `ANTHROPIC_API_KEY`).
	 */
	readonly apiKey: string | undefined;
}

export const defaultAiHostConfiguration: IAiHostConfiguration = {
	provider: 'anthropic',
	model: 'claude-sonnet-5-5',
	effort: 'low',
	apiKey: undefined,
};

/** Secret storage key for the Anthropic API key. */
export const aiAnthropicApiKeySecret = 'aiAssistant.anthropicApiKey';

export const AiSettings = {
	section: 'aiAssistant',
	provider: 'aiAssistant.provider',
	model: 'aiAssistant.model',
	effort: 'aiAssistant.effort',
} as const;

export interface IAiChatChunk {
	readonly requestId: string;
	readonly text?: string;
	readonly done?: boolean;
	readonly error?: string;
}

export const IAiHostService = createDecorator<IAiHostService>('aiHostService');

export interface IAiHostService {

	readonly _serviceBrand: undefined;

	/**
	 * Streamed response fragments for all in-flight requests. Every request
	 * ends with exactly one chunk that has `done: true`.
	 */
	readonly onDidReceiveChunk: Event<IAiChatChunk>;

	/** Replaces the provider, model, effort and credentials used for new requests. */
	configure(configuration: IAiHostConfiguration): Promise<void>;

	/**
	 * Starts a request. Resolves once the request has been accepted; the
	 * response arrives through {@link onDidReceiveChunk}. Rejects if the
	 * conversation already has a request in flight.
	 */
	sendRequest(request: IAiChatRequest): Promise<void>;

	cancelRequest(requestId: string): Promise<void>;

	/** Forgets the history of a conversation. */
	resetConversation(conversationId: string): Promise<void>;
}
