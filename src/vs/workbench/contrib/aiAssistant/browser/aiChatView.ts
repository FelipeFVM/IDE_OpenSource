/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiAssistant.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { disposableTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IAiChatChunk, IAiHostService } from '../../../../platform/aiHost/common/aiHost.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { EditorMarkdownCodeBlockRenderer } from '../../../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { getCodeBlockInsertText } from '../common/aiInsertCode.js';
import { IAiEditorContextService, IAiEditorContextSummary } from './aiEditorContextService.js';

/** How long the "Copied" confirmation stays on a code block's copy button. */
const COPIED_FEEDBACK_MS = 1500;

/** How often a streaming reply is re-rendered as Markdown. */
const RENDER_INTERVAL_MS = 100;

interface IActiveRequest {
	readonly requestId: string;
	readonly element: HTMLElement;
	text: string;
	readonly renderScheduler: RunOnceScheduler;
	readonly rendered: MutableDisposable<DisposableStore>;
}

export class AiChatViewPane extends ViewPane {

	static readonly ID = 'workbench.view.aiAssistant.chat';

	private root!: HTMLElement;
	private messages!: HTMLElement;
	private emptyMessage: HTMLElement | undefined;
	private contextLabel!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private submitButton!: Button;

	private conversationId = generateUuid();
	private activeRequest: IActiveRequest | undefined;
	/** Rendered Markdown and render schedulers of the current conversation. */
	private readonly conversationDisposables = this._register(new DisposableStore());
	private readonly codeBlockRenderer: EditorMarkdownCodeBlockRenderer;

	constructor(
		options: IViewletViewOptions,
		@IAiHostService private readonly aiHostService: IAiHostService,
		@IAiEditorContextService private readonly editorContextService: IAiEditorContextService,
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.codeBlockRenderer = instantiationService.createInstance(EditorMarkdownCodeBlockRenderer);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.root = append(container, $('.ai-assistant'));
		this.messages = append(this.root, $('.ai-assistant-messages', { role: 'log', 'aria-live': 'polite' }));
		this.renderEmptyState();

		const composer = append(this.root, $('.ai-assistant-composer'));
		this.contextLabel = append(composer, $('.ai-assistant-context'));
		this.input = append(composer, $<HTMLTextAreaElement>('textarea.ai-assistant-input', {
			rows: '3',
			placeholder: localize('aiAssistant.placeholder', "Ask a question (Enter to send, Shift+Enter for a new line)"),
			'aria-label': localize('aiAssistant.inputLabel', "AI chat input"),
		}));
		this.submitButton = this._register(new Button(append(composer, $('.ai-assistant-actions')), { ...defaultButtonStyles }));

		this._register(addDisposableListener(this.input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		}));
		this._register(this.submitButton.onDidClick(() => this.activeRequest ? this.cancel() : this.submit()));
		this._register(this.aiHostService.onDidReceiveChunk(chunk => this.onChunk(chunk)));
		this._register(this.editorContextService.onDidChangeContext(summary => this.renderContext(summary)));

		this.renderContext(this.editorContextService.getSummary());
		this.updateButton();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.root.style.height = `${height}px`;
	}

	override focus(): void {
		super.focus();
		this.input.focus();
	}

	/** Starts a new conversation: the AI host forgets the previous history. */
	newChat(): void {
		this.cancel();
		this.finish(this.activeRequest?.requestId, undefined);
		void this.aiHostService.resetConversation(this.conversationId);
		this.conversationId = generateUuid();
		this.conversationDisposables.clear();
		clearNode(this.messages);
		this.renderEmptyState();
		this.input.focus();
	}

	private renderEmptyState(): void {
		this.emptyMessage = append(this.messages, $('.ai-assistant-empty', undefined, localize('aiAssistant.empty', "Ask about the code in the active editor.")));
	}

	private async submit(): Promise<void> {
		const prompt = this.input.value.trim();
		if (!prompt || this.activeRequest) {
			return;
		}

		this.emptyMessage?.remove();
		this.emptyMessage = undefined;
		this.appendMessage('user').textContent = prompt;
		this.input.value = '';

		const requestId = generateUuid();
		const element = this.appendMessage('assistant');
		element.classList.add('pending');
		element.textContent = localize('aiAssistant.thinking', "Thinking…");

		const request: IActiveRequest = {
			requestId,
			element,
			text: '',
			renderScheduler: this.conversationDisposables.add(new RunOnceScheduler(() => this.renderReply(request, false), RENDER_INTERVAL_MS)),
			rendered: this.conversationDisposables.add(new MutableDisposable<DisposableStore>()),
		};
		this.activeRequest = request;
		this.updateButton();

		try {
			await this.aiHostService.sendRequest({
				requestId,
				conversationId: this.conversationId,
				prompt,
				context: this.editorContextService.getContext(),
			});
		} catch (error) {
			this.finish(requestId, toErrorMessage(error));
		}
	}

	private cancel(): void {
		if (this.activeRequest) {
			void this.aiHostService.cancelRequest(this.activeRequest.requestId);
		}
	}

	private onChunk(chunk: IAiChatChunk): void {
		const request = this.activeRequest;
		if (!request || request.requestId !== chunk.requestId) {
			return;
		}
		if (chunk.text) {
			request.text += chunk.text;
			if (!request.renderScheduler.isScheduled()) {
				request.renderScheduler.schedule();
			}
		}
		if (chunk.done) {
			this.finish(chunk.requestId, chunk.error);
		}
	}

	/**
	 * Renders the reply as untrusted Markdown (no HTML, no command links).
	 * While streaming, unfinished syntax such as an open code fence is closed
	 * so the partial reply already renders as it will look when complete.
	 */
	private renderReply(request: IActiveRequest, final: boolean): void {
		if (!request.text) {
			return;
		}
		const store = new DisposableStore();
		const rendered = store.add(this.markdownRendererService.render(new MarkdownString(request.text), {
			fillInIncompleteTokens: !final,
			asyncRenderCallback: () => this.scrollToBottom(),
			codeBlockRenderer: (languageAlias, code) => this.renderCodeBlock(languageAlias, code, final, store),
		}));
		request.element.classList.remove('pending');
		request.element.replaceChildren(rendered.element);
		request.rendered.value = store;
		this.scrollToBottom();
	}

	/**
	 * Syntax-highlighted code block. Once the reply is complete it also gets
	 * Copy and Insert at Cursor actions; while streaming, the code may still be
	 * incomplete, so no actions are offered.
	 */
	private async renderCodeBlock(languageAlias: string, code: string, final: boolean, store: DisposableStore): Promise<HTMLElement> {
		const highlighted = await this.codeBlockRenderer.renderCodeBlock(languageAlias, code, {});
		const block = $('.ai-assistant-code-block');
		if (final && !store.isDisposed) {
			const toolbar = append(block, $('.ai-assistant-code-toolbar'));
			const buttonOptions = { ...defaultButtonStyles, secondary: true, supportIcons: true };

			const copyLabel = `$(copy) ${localize('aiAssistant.copyCode', "Copy")}`;
			const copyButton = store.add(new Button(toolbar, { ...buttonOptions, title: localize('aiAssistant.copyCode.title', "Copy code to the clipboard") }));
			copyButton.label = copyLabel;
			const copyFeedback = store.add(new DisposableStore());
			store.add(copyButton.onDidClick(async () => {
				await this.clipboardService.writeText(code);
				copyButton.label = `$(check) ${localize('aiAssistant.copiedCode', "Copied")}`;
				copyFeedback.clear();
				disposableTimeout(() => copyButton.label = copyLabel, COPIED_FEEDBACK_MS, copyFeedback);
			}));

			const insertButton = store.add(new Button(toolbar, { ...buttonOptions, title: localize('aiAssistant.insertCode.title', "Insert code at the cursor in the active editor, replacing the selection") }));
			insertButton.label = `$(insert) ${localize('aiAssistant.insertCode', "Insert at Cursor")}`;
			store.add(insertButton.onDidClick(() => this.insertIntoActiveEditor(code)));
		}
		append(block, highlighted);
		return block;
	}

	private insertIntoActiveEditor(code: string): void {
		const editor = this.codeEditorService.getActiveCodeEditor();
		const selection = editor?.getSelection();
		if (!editor?.hasModel() || !selection) {
			this.notificationService.info(localize('aiAssistant.insertCode.noEditor', "Open a file in the editor to insert the code."));
			return;
		}
		if (editor.getOption(EditorOption.readOnly)) {
			this.notificationService.info(localize('aiAssistant.insertCode.readOnly', "The active editor is read-only."));
			return;
		}
		const text = getCodeBlockInsertText(editor.getModel(), selection, code);

		// One undoable edit that replaces the selection (or inserts at the cursor).
		editor.pushUndoStop();
		editor.executeEdits('aiAssistant.insertCode', [{ range: selection, text, forceMoveMarkers: true }]);
		editor.pushUndoStop();
		editor.focus();
	}

	private finish(requestId: string | undefined, error: string | undefined): void {
		const request = this.activeRequest;
		if (!request || request.requestId !== requestId) {
			return;
		}
		request.renderScheduler.cancel();
		this.renderReply(request, true);
		request.element.classList.remove('pending');
		if (error) {
			if (!request.text) {
				clearNode(request.element);
			}
			append(request.element, $('.ai-assistant-error', undefined, error));
		} else if (!request.text) {
			request.element.textContent = localize('aiAssistant.noResponse', "(no response)");
		}
		this.activeRequest = undefined;
		this.updateButton();
		this.scrollToBottom();
	}

	private appendMessage(role: 'user' | 'assistant'): HTMLElement {
		const element = append(this.messages, $(`.ai-assistant-message.${role}`));
		this.scrollToBottom();
		return element;
	}

	private scrollToBottom(): void {
		this.messages.scrollTop = this.messages.scrollHeight;
	}

	private updateButton(): void {
		this.submitButton.label = this.activeRequest
			? localize('aiAssistant.stop', "Stop")
			: localize('aiAssistant.send', "Send");
	}

	private renderContext(summary: IAiEditorContextSummary | undefined): void {
		if (!summary) {
			this.contextLabel.textContent = localize('aiAssistant.noEditor', "No active editor");
			return;
		}
		const parts = [summary.fileName, summary.languageId];
		if (summary.cursor) {
			parts.push(localize('aiAssistant.cursor', "Ln {0}, Col {1}", summary.cursor.lineNumber, summary.cursor.column));
		}
		if (summary.selectedCharacters > 0) {
			parts.push(localize('aiAssistant.selection', "{0} selected", summary.selectedCharacters));
		}
		this.contextLabel.textContent = parts.join(' · ');
	}
}
