import {readFileSync} from 'node:fs';
import {evaluateRetrieval,type RetrievalFixture} from '@testpilot/harness-testing/retrieve';
const fixture=JSON.parse(readFileSync(new URL('../../packages/harness-testing/test/fixtures/retrieval-synthetic.json',import.meta.url),'utf8')) as RetrievalFixture;
console.log(JSON.stringify(evaluateRetrieval(fixture),null,2));
