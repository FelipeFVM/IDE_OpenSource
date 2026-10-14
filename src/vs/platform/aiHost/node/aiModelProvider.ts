/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { basename } from '../../../base/common/path.js';
import { IAiChatRequest, IAiHostConfiguration } from '../common/aiHost.js';

/**
 * A model backend. Implementations stream text fragments and must stop
 * promptly once the token is cancelled. A provider owns the history of its
 * conversations and only records a turn once it completed successfully.
 */
export interface IAiModelProvider {
	readonly id: string;
	configure(configuration: IAiHostConfiguration): void;
	streamChat(request: IAiChatRequest, token: CancellationToken): AsyncIterable<string>;
	resetConversation(conversationId: string): void;
}

/**
 * Test provider: echoes the prompt and a summary of the editor context back
 * word by word, to exercise streaming end to end without a real model.
 */
export class EchoModelProvider implements IAiModelProvider {

	readonly id = 'echo';

	constructor(private readonly delayMs = 25) { }

	configure(): void { }

	resetConversation(): void { }

	async *streamChat(request: IAiChatRequest, token: CancellationToken): AsyncIterable<string> {
		for (const part of this.composeReply(request).split(/(\s+)/)) {
			if (token.isCancellationRequested) {
				return;
			}
			if (part) {
				yield part;
				await timeout(this.delayMs);
			}
		}
	}

	private composeReply(request: IAiChatRequest): string {
		const lines = [`[echo] ${request.prompt}`, ''];
		const context = request.context;
		if (!context) {
			lines.push('No active editor.');
			return lines.join('\n');
		}

		const cursor = context.cursor ? `Ln ${context.cursor.lineNumber}, Col ${context.cursor.column}` : 'no cursor';
		lines.push(`File: ${basename(context.fileName)} (${context.languageId}, ${context.lineCount} lines, v${context.versionId})`);
		lines.push(`Cursor: ${cursor}`);
		lines.push(`Selections: ${context.selections.length}, ${context.selectedText.length} characters selected`);
		lines.push(`Content received: ${context.content.length} characters${context.contentTruncated ? ' (truncated)' : ''}`);
		if (context.selectedText) {
			const excerpt = context.selectedText.length > 500 ? `${context.selectedText.slice(0, 500)}…` : context.selectedText;
			lines.push('', 'Selected text:', excerpt);
		}
		return lines.join('\n');
	}
}
