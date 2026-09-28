import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';

/**
 * 内置示例 = 仓库 `examples/<id>/example.json` 清单 + 它指向的领域知识 / 规则包文件。
 *
 * 领域内容是项目数据（CLAUDE.md「领域内容一律是项目数据」）：示例叫什么、指向哪个地址、
 * 起草提示怎么说，全部写在清单里，代码只认清单的形状。没有 `examples/` 目录就是没有示例，不报错。
 * `TP_EXAMPLES_DIR` 可以换目录（测试用）。
 */
const text=z.object({zh:z.string().min(1),en:z.string().min(1),ja:z.string().min(1)});
const manifestSchema=z.object({
  schemaVersion:z.literal('testpilot-example.v1'),
  id:z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title:text,
  label:text,
  projectHint:text.optional(),
  draftTitle:text.optional(),
  project:z.object({name:z.string().min(1),targetUrl:z.string().url(),platform:z.enum(['web','ios','android']).default('web'),explorationScope:z.enum(['current-url','rules']).optional()}),
  domainKnowledge:z.string().min(1).optional(),
  rulePack:z.string().min(1).optional(),
  /** 起草抽屉里的示例提示：base 是开头，其余按字段追加；缺的字段用界面的通用说法。 */
  draftPrompts:z.object({base:text,domainKnowledge:text.optional(),domainReference:text.optional(),rulePack:text.optional()}).optional(),
});
export type ExampleManifest=z.infer<typeof manifestSchema>;
export type LoadedExample={manifest:ExampleManifest;domainKnowledge?:string;rulePack?:unknown};

export function examplesDir(){return process.env.TP_EXAMPLES_DIR||fileURLToPath(new URL('../../examples/',import.meta.url));}

const cache=new Map<string,LoadedExample[]>();
export function loadExamples(dir=examplesDir()):LoadedExample[]{
  const hit=cache.get(dir);if(hit)return hit;
  const out:LoadedExample[]=[];
  if(existsSync(dir))for(const name of readdirSync(dir,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort()){
    const file=join(dir,name,'example.json');if(!existsSync(file))continue;
    try{
      const manifest=manifestSchema.parse(JSON.parse(readFileSync(file,'utf8')));
      const read=(f:string)=>readFileSync(join(dir,name,f),'utf8');
      out.push({manifest,...(manifest.domainKnowledge?{domainKnowledge:read(manifest.domainKnowledge)}:{}),...(manifest.rulePack?{rulePack:JSON.parse(read(manifest.rulePack))}:{})});
    }catch(e){console.warn(`[examples] skip ${file}: ${(e as Error).message}`);}
  }
  cache.set(dir,out);return out;
}

/** 给前端的清单：不带领域知识与规则包全文（那两份走 knowledge-library）。 */
export function listExamples(dir?:string){return loadExamples(dir).map(({manifest})=>{const {domainKnowledge,rulePack,...rest}=manifest;return {...rest,hasDomainKnowledge:!!domainKnowledge,hasRulePack:!!rulePack};});}
