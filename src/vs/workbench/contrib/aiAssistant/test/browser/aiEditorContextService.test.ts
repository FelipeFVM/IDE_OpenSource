/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { createTestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { aiMaxContentLength } from '../../../../../platform/aiHost/common/aiHost.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { AiEditorContextService, IAiEditorContextSummary } from '../../browser/aiEditorContextService.js';

suite('AiAssistant - AiEditorContextService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(text: string, path = '/work/app.ts') {
		const model = store.add(createTextModel(text, null, undefined, URI.file(path)));
		const editor = store.add(createTestCodeEditor(model));
		const onDidActiveEditorChange = store.add(new Emitter<void>());
		let active: ICodeEditor | null = editor;
		const editorService: Partial<IEditorService> = { onDidActiveEditorChange: onDidActiveEditorChange.event };
		const codeEditorService: Partial<ICodeEditorService> = { getActiveCodeEditor: () => active };
		const service = store.add(new AiEditorContextService(editorService as IEditorService, codeEditorService as ICodeEditorService));
		return {
			model, editor, service,
			setActive(next: ICodeEditor | null) {
				active = next;
				onDidActiveEditorChange.fire();
			},
		};
	}

	test('summarizes cursor and selections', () => {
		const { editor, service } = setup('const a = 1;\nconst b = 2;');
		editor.setSelections([new Selection(1, 1, 1, 6), new Selection(2, 7, 2, 8), new Selection(2, 3, 2, 3)]);

		assert.deepStrictEqual(service.getSummary(), {
			fileName: 'app.ts',
			languageId: 'plaintext',
			cursor: { lineNumber: 1, column: 6 },
			selectionCount: 2,
			selectedCharacters: 6,
		});
	});

	test('snapshot contains content, version and non-empty selections', () => {
		const { editor, model, service } = setup('const a = 1;\nconst b = 2;');
		editor.setSelections([new Selection(1, 1, 1, 6), new Selection(2, 7, 2, 8), new Selection(2, 3, 2, 3)]);

		const context = service.getContext()!;
		assert.strictEqual(context.uri, URI.file('/work/app.ts').toString());
		assert.strictEqual(context.fileName, URI.file('/work/app.ts').fsPath);
		assert.strictEqual(context.versionId, model.getVersionId());
		assert.strictEqual(context.lineCount, 2);
		assert.strictEqual(context.content, 'const a = 1;\nconst b = 2;');
		assert.strictEqual(context.contentTruncated, false);
		assert.strictEqual(context.selectedText, 'const\nb');
		assert.deepStrictEqual(context.selections, [
			{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
			{ startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 8 },
		]);
	});

	test('caps the content of large files', () => {
		const line = 'x'.repeat(99);
		const lineCount = Math.ceil(aiMaxContentLength / 100) + 10;
		const { service } = setup(Array.from({ length: lineCount }, () => line).join('\n'));

		const context = service.getContext()!;
		assert.strictEqual(context.contentTruncated, true);
		assert.strictEqual(context.content.length, aiMaxContentLength);
		assert.strictEqual(context.lineCount, lineCount);
	});

	test('reports no context without an active editor', () => {
		const { service, setActive } = setup('text');
		setActive(null);

		assert.strictEqual(service.getSummary(), undefined);
		assert.strictEqual(service.getContext(), undefined);
	});

	test('follows the active editor', () => {
		const first = setup('one', '/work/one.ts');
		const otherModel = store.add(createTextModel('two', null, undefined, URI.file('/work/two.ts')));
		const otherEditor = store.add(createTestCodeEditor(otherModel));

		first.setActive(otherEditor);

		assert.strictEqual(first.service.getSummary()?.fileName, 'two.ts');
		assert.strictEqual(first.service.getContext()?.content, 'two');
	});

	test('debounces change events and reports the latest state', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { editor, service } = setup('line one\nline two\nline three');
		await timeout(500); // let the initial event settle

		const events: (IAiEditorContextSummary | undefined)[] = [];
		store.add(service.onDidChangeContext(summary => events.push(summary)));

		editor.setPosition({ lineNumber: 1, column: 2 });
		editor.setPosition({ lineNumber: 2, column: 3 });
		editor.setPosition({ lineNumber: 3, column: 4 });
		await timeout(500);

		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(events[0]?.cursor, { lineNumber: 3, column: 4 });
	}));

	test('fires when the text changes', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { model, service } = setup('abc');
		await timeout(500);

		let fired = 0;
		store.add(service.onDidChangeContext(() => fired++));
		model.applyEdits([{ range: model.getFullModelRange(), text: 'changed' }]);
		await timeout(500);

		assert.strictEqual(fired, 1);
		assert.strictEqual(service.getContext()?.content, 'changed');
	}));
});
