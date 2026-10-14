/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type Anthropic from '@anthropic-ai/sdk';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { defaultAiHostConfiguration, IAiChatRequest, IAiEditorContext, IAiHostConfiguration } from '../common/aiHost.js';
import { IAiModelProvider } from './aiModelProvider.js';

type AnthropicSdk = typeof import('@anthropic-ai/sdk');
type StreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0];
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

const MAX_TOKENS = 64_000;

/**
 * Server-side refusal fallback: when the model declines on policy grounds,
 * the API re-runs the request on a suitable model within the same call.
 * Only sent for models that support the `"default"` form.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);

/** Kept byte-for-byte stable so that the cached prefix and earlier thinking blocks stay valid. */
const SYSTEM_PROMPT = [
	'You are an AI coding assistant built into a code editor.',
	'A user message may start with an <editor_context> block describing the file open in the editor: its path, language, cursor position, the selected text and the file content. Use it to ground your answer; when the file is marked unchanged, rely on the content sent earlier in the conversation.',
	'Reply in the language the user writes in. Format replies as Markdown and put code in fenced code blocks tagged with a language identifier.',
].join('\n\n');

export const missingApiKeyMessage = 'No Anthropic API key is configured. Run "AI Assistant: Set Anthropic API Key" from the Command Palette.';

interface IConversation {
	readonly messages: MessageParam[];
	/** Document versions whose full text is already part of the history, by URI. */
	readonly sentVersions: Map<string, number>;
}

/**
 * Streams replies from the Anthropic Messages API. Conversation history is
 * append-only: a turn is recorded only after it completed, and assistant
 * content (including thinking blocks) is passed back unchanged.
 */
export class AnthropicModelProvider implements IAiModelProvider {

	readonly id = 'anthropic';

	private configuration: IAiHostConfiguration = defaultAiHostConfiguration;
	private sdk: AnthropicSdk | undefined;
	private client: Anthropic | undefined;
	private readonly conversations = new Map<string, IConversation>();

	/**
	 * @param clientOptions extra SDK client options. Tests use this to run in
	 * the Electron test renderer, which the SDK treats as a browser.
	 */
	constructor(private readonly clientOptions: { readonly dangerouslyAllowBrowser?: boolean } = {}) { }

	configure(configuration: IAiHostConfiguration): void {
		if (configuration.apiKey !== this.configuration.apiKey) {
			this.client = undefined;
		}
		this.configuration = configuration;
	}

	resetConversation(conversationId: string): void {
		this.conversations.delete(conversationId);
	}

	async *streamChat(request: IAiChatRequest, token: CancellationToken): AsyncIterable<string> {
		const sdk = await this.loadSdk();
		const client = this.getClient(sdk);
		const { model, effort } = this.configuration;

		const conversation = this.conversations.get(request.conversationId) ?? { messages: [], sentVersions: new Map<string, number>() };
		const userMessage: MessageParam = { role: 'user', content: formatUserTurn(request, conversation.sentVersions) };

		const params: StreamParams & { fallbacks?: 'default' } = {
			model,
			max_tokens: MAX_TOKENS,
			system: SYSTEM_PROMPT,
			messages: [...conversation.messages, userMessage],
			output_config: { effort },
			// Automatic prompt caching of the conversation prefix.
			cache_control: { type: 'ephemeral' },
		};
		if (FALLBACK_MODELS.has(model)) {
			params.betas = [FALLBACK_BETA];
			params.fallbacks = 'default';
		}

		const stream = client.beta.messages.stream(params);
		const cancellation = token.onCancellationRequested(() => stream.abort());
		let message: Anthropic.Beta.BetaMessage;
		try {
			for await (const event of stream) {
				if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
					yield event.delta.text;
				}
			}
			message = await stream.finalMessage();
		} catch (error) {
			if (token.isCancellationRequested || error instanceof sdk.default.APIUserAbortError) {
				return;
			}
			throw toUserFacingError(sdk, error, model);
		} finally {
			cancellation.dispose();
		}

		if (message.stop_reason === 'refusal') {
			const category = message.stop_details?.category;
			throw new Error(`The model declined to answer${category ? ` (category: ${category})` : ''}.`);
		}

		// Record the completed turn. Cancelled, failed and refused turns are not
		// recorded, so the history only ever grows by whole turns.
		conversation.messages.push(userMessage, { role: 'assistant', content: echoableContent(message.content) });
		if (request.context) {
			conversation.sentVersions.set(request.context.uri, request.context.versionId);
		}
		this.conversations.set(request.conversationId, conversation);

		if (message.stop_reason === 'max_tokens') {
			yield '\n\n*(Response truncated: the output limit was reached.)*';
		}
	}

	private async loadSdk(): Promise<AnthropicSdk> {
		// Loaded on first use so the AI host starts quickly.
		this.sdk ??= await import('@anthropic-ai/sdk');
		return this.sdk;
	}

	private getClient(sdk: AnthropicSdk): Anthropic {
		if (!this.client) {
			const apiKey = this.configuration.apiKey;
			// Without a stored key the SDK falls back to the
			// ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN environment variables.
			const client = new sdk.default(apiKey ? { ...this.clientOptions, apiKey } : { ...this.clientOptions });
			if (!client.apiKey && !client.authToken) {
				throw new Error(missingApiKeyMessage);
			}
			this.client = client;
		}
		return this.client;
	}
}

function formatUserTurn(request: IAiChatRequest, sentVersions: ReadonlyMap<string, number>): string {
	const context = request.context;
	if (!context) {
		return request.prompt;
	}
	return `${formatEditorContext(context, sentVersions.get(context.uri) === context.versionId)}\n\n${request.prompt}`;
}

export function formatEditorContext(context: IAiEditorContext, unchanged: boolean): string {
	const lines = [
		'<editor_context>',
		`file: ${context.fileName}`,
		`language: ${context.languageId}`,
		`lines: ${context.lineCount}`,
	];
	if (context.cursor) {
		lines.push(`cursor: line ${context.cursor.lineNumber}, column ${context.cursor.column}`);
	}
	for (const selection of context.selections) {
		lines.push(`selection: line ${selection.startLineNumber}, column ${selection.startColumn} to line ${selection.endLineNumber}, column ${selection.endColumn}`);
	}
	if (context.selectedText) {
		lines.push('<selected_text>', context.selectedText, '</selected_text>');
	}
	if (unchanged) {
		lines.push('<file_content unchanged="true" />');
	} else {
		lines.push(context.contentTruncated ? '<file_content truncated="true">' : '<file_content>', context.content, '</file_content>');
	}
	lines.push('</editor_context>');
	return lines.join('\n');
}

/**
 * Assistant content to send back on the next turn. After a mid-output
 * refusal fallback, model-internal blocks produced before the last
 * `fallback` marker must be omitted; text blocks and everything after the
 * marker are passed back unchanged.
 */
export function echoableContent(content: readonly ContentBlock[]): ContentBlock[] {
	const typeOf = (block: ContentBlock) => (block as { type: string }).type;
	let boundary = -1;
	content.forEach((block, index) => {
		if (typeOf(block) === 'fallback') {
			boundary = index;
		}
	});
	return content.filter((block, index) => index > boundary || typeOf(block) === 'text');
}

function toUserFacingError(sdk: AnthropicSdk, error: unknown, model: string): Error {
	const Sdk = sdk.default;
	if (error instanceof Sdk.AuthenticationError) {
		return new Error('The Anthropic API rejected the API key. Run "AI Assistant: Set Anthropic API Key" to update it.');
	}
	if (error instanceof Sdk.PermissionDeniedError) {
		return new Error(`The API key does not have access to this request: ${error.message}`);
	}
	if (error instanceof Sdk.NotFoundError) {
		return new Error(`Model "${model}" was not found. Check the "aiAssistant.model" setting.`);
	}
	if (error instanceof Sdk.RateLimitError) {
		return new Error('The Anthropic API rate limit was reached. Try again shortly.');
	}
	if (error instanceof Sdk.APIError) {
		return new Error(`Anthropic API error${error.status ? ` ${error.status}` : ''}: ${error.message}`);
	}
	return error instanceof Error ? error : new Error(String(error));
}
