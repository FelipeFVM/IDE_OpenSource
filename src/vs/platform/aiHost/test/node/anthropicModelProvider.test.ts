/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type * as http from 'http';
import type { AddressInfo } from 'net';
import type Anthropic from '@anthropic-ai/sdk';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { defaultAiHostConfiguration, IAiChatRequest, IAiEditorContext } from '../../common/aiHost.js';
import { AnthropicModelProvider, echoableContent, formatEditorContext } from '../../node/anthropicModelProvider.js';

interface IRecordedBody {
	readonly model: string;
	readonly stream: boolean;
	readonly fallbacks?: string;
	readonly output_config?: unknown;
	readonly cache_control?: unknown;
	readonly messages: Array<{ role: string; content: unknown }>;
}

interface IRecordedRequest {
	readonly headers: http.IncomingHttpHeaders;
	readonly body: IRecordedBody;
}

/** Minimal stand-in for `POST /v1/messages` that streams a fixed reply as SSE. */
class FakeMessagesApi {

	readonly requests: IRecordedRequest[] = [];
	reply: { text: string; stopReason?: string; status?: number } = { text: 'Hello **world**' };

	private server: http.Server | undefined;

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		let raw = '';
		req.on('data', chunk => raw += chunk);
		req.on('end', () => {
			this.requests.push({ headers: req.headers, body: JSON.parse(raw) });
			const { text, stopReason = 'end_turn', status = 200 } = this.reply;
			if (status !== 200) {
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'failure' } }));
				return;
			}
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
			send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
			send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
			send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } });
			send('content_block_stop', { index: 0 });
			send('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
			for (const part of text.split(/(?<= )/)) {
				send('content_block_delta', { index: 1, delta: { type: 'text_delta', text: part } });
			}
			send('content_block_stop', { index: 1 });
			send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
			send('message_stop', {});
			res.end();
		});
	}

	async start(): Promise<string> {
		const { createServer } = await import('http');
		const server = this.server = createServer((req, res) => this.handle(req, res));
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	stop(): Promise<void> {
		return new Promise(resolve => this.server ? this.server.close(() => resolve()) : resolve());
	}
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
	let text = '';
	for await (const part of stream) {
		text += part;
	}
	return text;
}

const context: IAiEditorContext = {
	uri: 'file:///work/app.ts',
	fileName: '/work/app.ts',
	languageId: 'typescript',
	versionId: 7,
	lineCount: 2,
	cursor: { lineNumber: 1, column: 3 },
	selections: [],
	selectedText: '',
	content: 'const a = 1;\nconst b = 2;',
	contentTruncated: false,
};

/** The Electron test runner hosts node tests in a renderer, which the SDK treats as a browser. */
const testClientOptions = { dangerouslyAllowBrowser: true };

function request(requestId: string, prompt: string, conversationId = 'c1'): IAiChatRequest {
	return { requestId, conversationId, prompt, context };
}

suite('AnthropicModelProvider', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let api: FakeMessagesApi;
	let previousBaseUrl: string | undefined;

	setup(async () => {
		api = new FakeMessagesApi();
		previousBaseUrl = process.env['ANTHROPIC_BASE_URL'];
		process.env['ANTHROPIC_BASE_URL'] = await api.start();
	});

	teardown(async () => {
		if (previousBaseUrl === undefined) {
			delete process.env['ANTHROPIC_BASE_URL'];
		} else {
			process.env['ANTHROPIC_BASE_URL'] = previousBaseUrl;
		}
		await api.stop();
	});

	test('streams text and sends model, effort, fallback and caching settings', async () => {
		const provider = new AnthropicModelProvider(testClientOptions);
		provider.configure({ ...defaultAiHostConfiguration, apiKey: 'test-key' });

		const text = await collect(provider.streamChat(request('r1', 'What does this do?'), CancellationToken.None));

		assert.strictEqual(text, 'Hello **world**');
		const [{ headers, body }] = api.requests;
		assert.strictEqual(headers['x-api-key'], 'test-key');
		assert.ok(String(headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'));
		assert.strictEqual(body.model, 'claude-sonnet-5-5');
		assert.strictEqual(body.fallbacks, 'default');
		assert.deepStrictEqual(body.output_config, { effort: 'low' });
		assert.deepStrictEqual(body.cache_control, { type: 'ephemeral' });
		assert.strictEqual(body.stream, true);
		assert.strictEqual(body.messages.length, 1);
		const userTurn = body.messages[0].content as string;
		assert.ok(userTurn.startsWith('<editor_context>\nfile: /work/app.ts'));
		assert.ok(userTurn.includes('const a = 1;'));
		assert.ok(userTurn.endsWith('What does this do?'));
	});

	test('replays the full assistant turn and omits unchanged file content', async () => {
		const provider = new AnthropicModelProvider(testClientOptions);
		provider.configure({ ...defaultAiHostConfiguration, apiKey: 'test-key' });

		await collect(provider.streamChat(request('r1', 'first'), CancellationToken.None));
		await collect(provider.streamChat(request('r2', 'second'), CancellationToken.None));

		const { messages } = api.requests[1].body;
		assert.deepStrictEqual(messages.map(message => message.role), ['user', 'assistant', 'user']);
		// The first user turn is sent again byte for byte.
		assert.deepStrictEqual(messages[0], api.requests[0].body.messages[0]);
		// The assistant turn keeps its thinking block unchanged.
		const assistantContent = messages[1].content as Array<{ type: string; signature?: string; text?: string }>;
		assert.deepStrictEqual(assistantContent.map(block => block.type), ['thinking', 'text']);
		assert.strictEqual(assistantContent[0].signature, 'sig-1');
		assert.strictEqual(assistantContent[1].text, 'Hello **world**');
		// The document version was already sent, so its text is not repeated.
		const secondTurn = messages[2].content as string;
		assert.ok(secondTurn.includes('<file_content unchanged="true" />'));
		assert.ok(!secondTurn.includes('const a = 1;'));
	});

	test('does not record failed turns and resets conversations', async () => {
		const provider = new AnthropicModelProvider(testClientOptions);
		provider.configure({ ...defaultAiHostConfiguration, apiKey: 'test-key' });

		api.reply = { text: '', status: 400 };
		await assert.rejects(() => collect(provider.streamChat(request('r1', 'fails'), CancellationToken.None)), /Anthropic API error 400/);

		api.reply = { text: 'ok' };
		await collect(provider.streamChat(request('r2', 'works'), CancellationToken.None));
		assert.strictEqual(api.requests[1].body.messages.length, 1, 'failed turn must not be replayed');

		provider.resetConversation('c1');
		await collect(provider.streamChat(request('r3', 'fresh'), CancellationToken.None));
		assert.strictEqual(api.requests[2].body.messages.length, 1);
		assert.ok((api.requests[2].body.messages[0].content as string).includes('const a = 1;'), 'file content is sent again after a reset');
	});

	test('asks for an API key when no credentials are available', async () => {
		const saved = { key: process.env['ANTHROPIC_API_KEY'], token: process.env['ANTHROPIC_AUTH_TOKEN'] };
		delete process.env['ANTHROPIC_API_KEY'];
		delete process.env['ANTHROPIC_AUTH_TOKEN'];
		try {
			const provider = new AnthropicModelProvider(testClientOptions);
			provider.configure({ ...defaultAiHostConfiguration, apiKey: undefined });
			await assert.rejects(() => collect(provider.streamChat(request('r1', 'x'), CancellationToken.None)), /Set Anthropic API Key/);
			assert.strictEqual(api.requests.length, 0);
		} finally {
			if (saved.key !== undefined) { process.env['ANTHROPIC_API_KEY'] = saved.key; }
			if (saved.token !== undefined) { process.env['ANTHROPIC_AUTH_TOKEN'] = saved.token; }
		}
	});

	test('reports refusals as errors', async () => {
		const provider = new AnthropicModelProvider(testClientOptions);
		provider.configure({ ...defaultAiHostConfiguration, apiKey: 'test-key' });
		api.reply = { text: 'partial', stopReason: 'refusal' };

		await assert.rejects(() => collect(provider.streamChat(request('r1', 'x'), CancellationToken.None)), /declined/);
	});

	test('omits fallbacks for models without server-side fallback', async () => {
		const provider = new AnthropicModelProvider(testClientOptions);
		provider.configure({ ...defaultAiHostConfiguration, model: 'claude-haiku-5-5', apiKey: 'test-key' });

		await collect(provider.streamChat(request('r1', 'x'), CancellationToken.None));

		const { headers, body } = api.requests[0];
		assert.strictEqual(body.fallbacks, undefined);
		assert.ok(!String(headers['anthropic-beta'] ?? '').includes('server-side-fallback'));
	});

	test('echoableContent drops model-internal blocks before the last fallback marker', () => {
		const content = [
			{ type: 'thinking', thinking: '', signature: 'a' },
			{ type: 'text', text: 'partial', citations: null },
			{ type: 'fallback', from: { model: 'x' }, to: { model: 'y' } },
			{ type: 'thinking', thinking: '', signature: 'b' },
			{ type: 'text', text: 'rest', citations: null },
		] as unknown as Anthropic.Beta.BetaContentBlock[];

		assert.deepStrictEqual(echoableContent(content).map(block => (block as { type: string }).type), ['text', 'thinking', 'text']);
		assert.strictEqual(echoableContent(content.slice(3)).length, 2, 'content without a fallback marker is unchanged');
	});

	test('formatEditorContext includes selections and marks truncation', () => {
		const formatted = formatEditorContext({
			...context,
			selections: [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }],
			selectedText: 'const',
			contentTruncated: true,
		}, false);

		assert.ok(formatted.includes('selection: line 1, column 1 to line 1, column 6'));
		assert.ok(formatted.includes('<selected_text>\nconst\n</selected_text>'));
		assert.ok(formatted.includes('<file_content truncated="true">'));
	});
});
