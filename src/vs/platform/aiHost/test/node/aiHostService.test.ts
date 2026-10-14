/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { defaultAiHostConfiguration, IAiChatChunk, IAiChatRequest, IAiEditorContext, IAiHostConfiguration } from '../../common/aiHost.js';
import { EchoModelProvider, IAiModelProvider } from '../../node/aiModelProvider.js';
import { AiHostService } from '../../node/aiHostService.js';

function collect(service: AiHostService, requestId: string): Promise<IAiChatChunk[]> {
	const chunks: IAiChatChunk[] = [];
	const done = new DeferredPromise<IAiChatChunk[]>();
	const listener = service.onDidReceiveChunk(chunk => {
		if (chunk.requestId !== requestId) {
			return;
		}
		chunks.push(chunk);
		if (chunk.done) {
			listener.dispose();
			done.complete(chunks);
		}
	});
	return done.p;
}

const echoConfiguration: IAiHostConfiguration = { ...defaultAiHostConfiguration, provider: 'echo' };

const context: IAiEditorContext = {
	uri: 'file:///work/app.ts',
	fileName: '/work/app.ts',
	languageId: 'typescript',
	versionId: 3,
	lineCount: 10,
	cursor: { lineNumber: 2, column: 5 },
	selections: [{ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6 }],
	selectedText: 'const',
	content: 'line1\nconst x = 1;',
	contentTruncated: false,
};

suite('AiHostService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('streams the echo reply with editor context and finishes once', async () => {
		const service = new AiHostService([new EchoModelProvider(0)], echoConfiguration);
		const result = collect(service, 'r1');
		await service.sendRequest({ requestId: 'r1', conversationId: 'c1', prompt: 'explain this', context });
		const chunks = await result;
		service.dispose();

		const text = chunks.map(chunk => chunk.text ?? '').join('');
		assert.ok(text.startsWith('[echo] explain this'));
		assert.ok(text.includes('app.ts (typescript, 10 lines, v3)'));
		assert.ok(text.includes('Ln 2, Col 5'));
		assert.ok(text.includes('Selected text:\nconst'));
		assert.strictEqual(chunks.filter(chunk => chunk.done).length, 1);
		assert.strictEqual(chunks.at(-1)?.done, true);
		assert.strictEqual(chunks.at(-1)?.error, undefined);
	});

	test('cancelRequest stops streaming and still ends the request', async () => {
		const started = new DeferredPromise<void>();
		const provider: IAiModelProvider = {
			id: 'test',
			configure() { },
			resetConversation() { },
			async *streamChat(_request: IAiChatRequest, token: CancellationToken) {
				yield 'first';
				started.complete();
				while (!token.isCancellationRequested) {
					await new Promise(resolve => setTimeout(resolve, 1));
				}
				yield 'after-cancel';
			}
		};
		const service = new AiHostService([provider], { ...echoConfiguration, provider: provider.id });
		const result = collect(service, 'r2');
		await service.sendRequest({ requestId: 'r2', conversationId: 'c1', prompt: 'p', context: undefined });
		await started.p;
		await service.cancelRequest('r2');
		const chunks = await result;
		service.dispose();

		assert.deepStrictEqual(chunks.map(chunk => chunk.text).filter(Boolean), ['first']);
		assert.strictEqual(chunks.at(-1)?.done, true);
	});

	test('provider errors are reported on the final chunk', async () => {
		const provider: IAiModelProvider = {
			id: 'failing',
			configure() { },
			resetConversation() { },
			async *streamChat() {
				throw new Error('boom');
			}
		};
		const service = new AiHostService([provider], { ...echoConfiguration, provider: provider.id });
		const result = collect(service, 'r3');
		await service.sendRequest({ requestId: 'r3', conversationId: 'c1', prompt: 'p', context: undefined });
		const chunks = await result;
		service.dispose();

		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].done, true);
		assert.ok(chunks[0].error?.includes('boom'));
	});

	test('rejects a second request while the conversation is busy', async () => {
		const service = new AiHostService([new EchoModelProvider(0)], echoConfiguration);
		const result = collect(service, 'r5');
		await service.sendRequest({ requestId: 'r5', conversationId: 'busy', prompt: 'p', context: undefined });
		await assert.rejects(() => service.sendRequest({ requestId: 'r6', conversationId: 'busy', prompt: 'p', context: undefined }), /already has a request/);
		await result;
		service.dispose();
	});

	test('rejects duplicate request ids', async () => {
		const service = new AiHostService([new EchoModelProvider(0)], echoConfiguration);
		const result = collect(service, 'r4');
		await service.sendRequest({ requestId: 'r4', conversationId: 'c1', prompt: 'p', context: undefined });
		await assert.rejects(() => service.sendRequest({ requestId: 'r4', conversationId: 'c1', prompt: 'p', context: undefined }));
		await result;
		service.dispose();
	});
});
