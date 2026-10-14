/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { defaultAiHostConfiguration, IAiChatChunk, IAiChatRequest, IAiHostConfiguration, IAiHostService } from '../common/aiHost.js';
import { IAiModelProvider } from './aiModelProvider.js';

interface IRunningRequest {
	readonly conversationId: string;
	readonly cts: CancellationTokenSource;
}

/**
 * Runs inside the AI host utility process. Model calls happen here so that
 * network latency and response processing never block the renderer.
 */
export class AiHostService extends Disposable implements IAiHostService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidReceiveChunk = this._register(new Emitter<IAiChatChunk>());
	readonly onDidReceiveChunk = this._onDidReceiveChunk.event;

	private readonly providers: ReadonlyMap<string, IAiModelProvider>;
	private configuration: IAiHostConfiguration;
	private readonly requests = new Map<string, IRunningRequest>();

	constructor(providers: readonly IAiModelProvider[], configuration: IAiHostConfiguration = defaultAiHostConfiguration) {
		super();
		this.providers = new Map(providers.map(provider => [provider.id, provider]));
		this.configuration = configuration;
		this.applyConfiguration();
	}

	async configure(configuration: IAiHostConfiguration): Promise<void> {
		this.configuration = configuration;
		this.applyConfiguration();
	}

	private applyConfiguration(): void {
		for (const provider of this.providers.values()) {
			provider.configure(this.configuration);
		}
	}

	async sendRequest(request: IAiChatRequest): Promise<void> {
		if (this.requests.has(request.requestId)) {
			throw new Error(`Duplicate AI request id: ${request.requestId}`);
		}
		for (const running of this.requests.values()) {
			if (running.conversationId === request.conversationId) {
				throw new Error('This conversation already has a request in progress.');
			}
		}

		const provider = this.providers.get(this.configuration.provider);
		if (!provider) {
			throw new Error(`Unknown AI provider: ${this.configuration.provider}`);
		}

		const cts = new CancellationTokenSource();
		this.requests.set(request.requestId, { conversationId: request.conversationId, cts });

		// Not awaited: the call resolves as soon as the request is accepted
		// and the response is delivered through onDidReceiveChunk.
		void this.run(provider, request, cts);
	}

	async cancelRequest(requestId: string): Promise<void> {
		this.requests.get(requestId)?.cts.cancel();
	}

	async resetConversation(conversationId: string): Promise<void> {
		for (const provider of this.providers.values()) {
			provider.resetConversation(conversationId);
		}
	}

	private async run(provider: IAiModelProvider, request: IAiChatRequest, cts: CancellationTokenSource): Promise<void> {
		const { requestId } = request;
		try {
			for await (const text of provider.streamChat(request, cts.token)) {
				if (cts.token.isCancellationRequested) {
					break;
				}
				this._onDidReceiveChunk.fire({ requestId, text });
			}
			this._onDidReceiveChunk.fire({ requestId, done: true });
		} catch (error) {
			this._onDidReceiveChunk.fire({ requestId, done: true, error: toErrorMessage(error) });
		} finally {
			this.requests.delete(requestId);
			cts.dispose();
		}
	}

	override dispose(): void {
		for (const { cts } of this.requests.values()) {
			cts.dispose(true);
		}
		this.requests.clear();
		super.dispose();
	}
}
