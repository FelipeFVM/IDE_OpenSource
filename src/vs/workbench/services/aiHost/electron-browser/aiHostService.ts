/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { AiEffort, aiAnthropicApiKeySecret, aiHostChannelName, aiHostModuleId, AiSettings, defaultAiHostConfiguration, IAiChatChunk, IAiChatRequest, IAiHostConfiguration, IAiHostService } from '../../../../platform/aiHost/common/aiHost.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IUtilityProcessWorker, IUtilityProcessWorkerWorkbenchService } from '../../utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';

/**
 * Renderer side of the AI host. Forks the AI host utility process on first
 * use (one per window, terminated with the window) and talks to it over a
 * direct message port, so streamed tokens never pass through the main process.
 */
export class AiHostService extends Disposable implements IAiHostService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidReceiveChunk = this._register(new Emitter<IAiChatChunk>());
	readonly onDidReceiveChunk = this._onDidReceiveChunk.event;

	private readonly _worker = this._register(new MutableDisposable<IUtilityProcessWorker>());
	private readonly _workerEvents = this._register(new DisposableStore());
	private _proxy: Promise<IAiHostService> | undefined;
	private _workerGeneration = 0;

	/** Requests that have not received their final chunk yet. */
	private readonly _pendingRequests = new Set<string>();

	constructor(
		@IUtilityProcessWorkerWorkbenchService private readonly utilityProcessWorkerWorkbenchService: IUtilityProcessWorkerWorkbenchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Keep a running AI host in sync with settings and the stored API key.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AiSettings.section)) {
				void this._pushConfiguration();
			}
		}));
		this._register(this.secretStorageService.onDidChangeSecret(key => {
			if (key === aiAnthropicApiKeySecret) {
				void this._pushConfiguration();
			}
		}));
	}

	async configure(configuration: IAiHostConfiguration): Promise<void> {
		const proxy = await this._getProxy();
		await proxy.configure(configuration);
	}

	async resetConversation(conversationId: string): Promise<void> {
		// Without a running AI host there is no history to forget.
		if (this._proxy) {
			await (await this._proxy).resetConversation(conversationId);
		}
	}

	private async _readConfiguration(): Promise<IAiHostConfiguration> {
		const effort = this.configurationService.getValue<AiEffort>(AiSettings.effort);
		return {
			provider: this.configurationService.getValue<string>(AiSettings.provider) || defaultAiHostConfiguration.provider,
			model: this.configurationService.getValue<string>(AiSettings.model)?.trim() || defaultAiHostConfiguration.model,
			effort: effort || defaultAiHostConfiguration.effort,
			apiKey: (await this.secretStorageService.get(aiAnthropicApiKeySecret)) || undefined,
		};
	}

	private async _pushConfiguration(): Promise<void> {
		if (!this._proxy) {
			return; // applied when the AI host starts
		}
		try {
			const [proxy, configuration] = await Promise.all([this._proxy, this._readConfiguration()]);
			await proxy.configure(configuration);
		} catch (error) {
			this.logService.error('[aiHost] failed to update configuration', error);
		}
	}

	async sendRequest(request: IAiChatRequest): Promise<void> {
		const proxy = await this._getProxy();
		this._pendingRequests.add(request.requestId);
		try {
			await proxy.sendRequest(request);
		} catch (error) {
			this._pendingRequests.delete(request.requestId);
			throw error;
		}
	}

	async cancelRequest(requestId: string): Promise<void> {
		if (!this._pendingRequests.has(requestId)) {
			return;
		}
		const proxy = await this._getProxy();
		await proxy.cancelRequest(requestId);
	}

	private _getProxy(): Promise<IAiHostService> {
		if (!this._proxy) {
			const proxy = this._createProxy(this._workerGeneration);
			this._proxy = proxy;
			// Allow a retry on the next call if the worker failed to start.
			proxy.catch(() => {
				if (this._proxy === proxy) {
					this._proxy = undefined;
				}
			});
		}
		return this._proxy;
	}

	private async _createProxy(generation: number): Promise<IAiHostService> {
		const worker = await this.utilityProcessWorkerWorkbenchService.createWorker({
			moduleId: aiHostModuleId,
			type: 'aiHost',
			name: 'ai-host',
		});
		if (generation !== this._workerGeneration || this._store.isDisposed) {
			worker.dispose();
			throw new CancellationError();
		}
		this._worker.value = worker;

		const proxy = ProxyChannel.toService<IAiHostService>(worker.client.getChannel(aiHostChannelName));
		this._workerEvents.clear();
		this._workerEvents.add(proxy.onDidReceiveChunk(chunk => {
			if (chunk.done) {
				this._pendingRequests.delete(chunk.requestId);
			}
			this._onDidReceiveChunk.fire(chunk);
		}));

		void worker.onDidTerminate.then(({ reason }) => {
			if (this._worker.value !== worker) {
				return;
			}
			this.logService.warn(`[aiHost] utility process terminated (code: ${reason?.code}, signal: ${reason?.signal})`);
			this._resetWorker();
		});

		// Configure before the first request so it uses the right provider and key.
		await proxy.configure(await this._readConfiguration());

		return proxy;
	}

	private _resetWorker(): void {
		this._workerGeneration++;
		this._workerEvents.clear();
		this._worker.clear();
		this._proxy = undefined;

		// Requests in flight can no longer complete; end them so the UI does not hang.
		for (const requestId of this._pendingRequests) {
			this._onDidReceiveChunk.fire({ requestId, done: true, error: 'The AI host process stopped unexpectedly. The conversation history was lost; start a new chat.' });
		}
		this._pendingRequests.clear();
	}

	override dispose(): void {
		this._workerGeneration++;
		super.dispose();
	}
}

registerSingleton(IAiHostService, AiHostService, InstantiationType.Delayed);
