/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { aiMaxContentLength, IAiEditorContext, IAiPosition, IAiRange } from '../../../../platform/aiHost/common/aiHost.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

/**
 * Lightweight description of the active editor, emitted on every relevant
 * change. Deliberately excludes the file content so that typing does not copy
 * the whole document on each keystroke; use {@link IAiEditorContextService.getContext}
 * for a full snapshot.
 */
export interface IAiEditorContextSummary {
	readonly fileName: string;
	readonly languageId: string;
	readonly cursor: IAiPosition | undefined;
	readonly selectionCount: number;
	readonly selectedCharacters: number;
}

export const IAiEditorContextService = createDecorator<IAiEditorContextService>('aiEditorContextService');

export interface IAiEditorContextService {

	readonly _serviceBrand: undefined;

	/** Fires (debounced) when the active editor, its model, cursor, selection or text changes. */
	readonly onDidChangeContext: Event<IAiEditorContextSummary | undefined>;

	getSummary(): IAiEditorContextSummary | undefined;

	/** Full snapshot of the active editor, including its (capped) text content. */
	getContext(): IAiEditorContext | undefined;
}

export class AiEditorContextService extends Disposable implements IAiEditorContextService {

	declare readonly _serviceBrand: undefined;

	private static readonly DEBOUNCE_MS = 150;

	private readonly _onDidChangeContext = this._register(new Emitter<IAiEditorContextSummary | undefined>());
	readonly onDidChangeContext = this._onDidChangeContext.event;

	private readonly editorListeners = this._register(new DisposableStore());
	private readonly scheduler = this._register(new RunOnceScheduler(() => this._onDidChangeContext.fire(this.getSummary()), AiEditorContextService.DEBOUNCE_MS));

	private activeEditor: ICodeEditor | null = null;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
	) {
		super();
		this._register(this.editorService.onDidActiveEditorChange(() => this.trackActiveEditor()));
		this.trackActiveEditor();
	}

	private trackActiveEditor(): void {
		const editor = this.codeEditorService.getActiveCodeEditor();
		if (editor !== this.activeEditor) {
			this.activeEditor = editor;
			this.editorListeners.clear();
			if (editor) {
				const schedule = () => this.scheduler.schedule();
				this.editorListeners.add(editor.onDidChangeModel(schedule));
				this.editorListeners.add(editor.onDidChangeModelLanguage(schedule));
				this.editorListeners.add(editor.onDidChangeCursorSelection(schedule));
				this.editorListeners.add(editor.onDidChangeModelContent(schedule));
				this.editorListeners.add(editor.onDidDispose(() => this.trackActiveEditor()));
			}
		}
		this.scheduler.schedule();
	}

	getSummary(): IAiEditorContextSummary | undefined {
		const editor = this.activeEditor;
		const model = editor?.getModel();
		if (!editor || !model) {
			return undefined;
		}
		const selections = editor.getSelections() ?? [];
		const position = editor.getPosition();
		return {
			fileName: basename(model.uri),
			languageId: model.getLanguageId(),
			cursor: position ? { lineNumber: position.lineNumber, column: position.column } : undefined,
			selectionCount: selections.filter(selection => !selection.isEmpty()).length,
			selectedCharacters: selections.reduce((total, selection) => total + model.getValueLengthInRange(selection), 0),
		};
	}

	getContext(): IAiEditorContext | undefined {
		const editor = this.activeEditor;
		const model = editor?.getModel();
		if (!editor || !model) {
			return undefined;
		}

		const selections = (editor.getSelections() ?? []).filter(selection => !selection.isEmpty());
		const ranges: IAiRange[] = selections.map(selection => ({
			startLineNumber: selection.startLineNumber,
			startColumn: selection.startColumn,
			endLineNumber: selection.endLineNumber,
			endColumn: selection.endColumn,
		}));
		const selectedText = selections.map(selection => model.getValueInRange(selection)).join('\n');

		const contentLength = model.getValueLength();
		const contentTruncated = contentLength > aiMaxContentLength;
		const content = contentTruncated
			? model.getValueInRange(Range.fromPositions({ lineNumber: 1, column: 1 }, model.getPositionAt(aiMaxContentLength)))
			: model.getValue();

		const position = editor.getPosition();
		return {
			uri: model.uri.toString(),
			fileName: model.uri.fsPath || model.uri.path,
			languageId: model.getLanguageId(),
			versionId: model.getVersionId(),
			lineCount: model.getLineCount(),
			cursor: position ? { lineNumber: position.lineNumber, column: position.column } : undefined,
			selections: ranges,
			selectedText,
			content,
			contentTruncated,
		};
	}
}

registerSingleton(IAiEditorContextService, AiEditorContextService, InstantiationType.Delayed);
