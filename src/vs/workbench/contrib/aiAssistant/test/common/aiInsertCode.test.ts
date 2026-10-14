/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { EndOfLineSequence } from '../../../../../editor/common/model.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { getCodeBlockInsertText } from '../../common/aiInsertCode.js';

suite('AiAssistant - getCodeBlockInsertText', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const block = 'function f() {\n\treturn 1;\n}';

	test('single-line snippets are inserted unchanged', () => {
		const model = store.add(createTextModel('const a = foo;'));
		assert.strictEqual(getCodeBlockInsertText(model, new Range(1, 11, 1, 14), 'bar()'), 'bar()');
	});

	test('a block inserted on an empty line is unchanged', () => {
		const model = store.add(createTextModel('a\n\nb'));
		assert.strictEqual(getCodeBlockInsertText(model, new Range(2, 1, 2, 1), block), block);
	});

	test('a block inserted before existing code ends with a line break', () => {
		const model = store.add(createTextModel('existing();'));
		assert.strictEqual(getCodeBlockInsertText(model, new Range(1, 1, 1, 1), block), `${block}\n`);
	});

	test('a block inserted after existing code starts with a line break', () => {
		const model = store.add(createTextModel('existing();'));
		assert.strictEqual(getCodeBlockInsertText(model, new Range(1, 12, 1, 12), block), `\n${block}`);
	});

	test('a block inserted in the middle of a line gets both line breaks', () => {
		const model = store.add(createTextModel('before(); after();'));
		assert.strictEqual(getCodeBlockInsertText(model, new Range(1, 10, 1, 10), block), `\n${block}\n`);
	});

	test('replacing a whole-line selection needs no extra line breaks', () => {
		const model = store.add(createTextModel('old();\nkeep();'));
		assert.strictEqual(getCodeBlockInsertText(model, new Range(1, 1, 1, 7), block), block);
	});

	test('whitespace around the insertion point does not count as code', () => {
		const model = store.add(createTextModel('\t\t'));
		assert.strictEqual(getCodeBlockInsertText(model, new Range(1, 2, 1, 2), block), block);
	});

	test('a block that already ends with a line break gets no second one', () => {
		const model = store.add(createTextModel('existing();'));
		assert.strictEqual(getCodeBlockInsertText(model, new Range(1, 1, 1, 1), `${block}\n`), `${block}\n`);
	});

	test('uses the document end-of-line sequence', () => {
		const model = store.add(createTextModel('x(); y();'));
		model.setEOL(EndOfLineSequence.CRLF);
		assert.strictEqual(getCodeBlockInsertText(model, new Range(1, 5, 1, 5), block), `\r\n${block}\r\n`);
	});
});
