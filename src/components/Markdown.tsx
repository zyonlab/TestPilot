import { cn } from "@/lib/cn";

/**
 * 够读一份规格的 markdown 渲染，不是一个编辑器。
 *
 * 规格是下游一切的输入——故事从它来，用例从故事来，断言引用的文案要能在它里面查到。
 * 而它此前在界面上的样子是 `source.spec` 参数框里的一行路径。**一个路径不是阅读方式。**
 *
 * 只处理标题、引用、列表、表格、代码块与行内强调：够把材料读明白。不引第三方渲染器，
 * 因为这里唯一的需求是读，而每多一个依赖就多一处会在离线环境里出问题的地方。
 * 输入按纯文本处理、不注入 HTML——材料来自磁盘上的文件，但渲染器不该假设它一定安全。
 */

/** Inline emphasis and code, applied to already-escaped text. */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("`"))
      out.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px]">
          {tok.slice(1, -1)}
        </code>,
      );
    else if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  let table: string[][] = [];
  let code: string[] | null = null;

  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="my-1.5 list-disc space-y-0.5 pl-5">
          {list.map((li, i) => (
            <li key={i}>{inline(li, `li${blocks.length}-${i}`)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
    if (table.length) {
      blocks.push(
        <div key={`tw-${blocks.length}`} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <tbody>
              {table.map((row, r) => (
                <tr key={r} className="border-b border-border/60">
                  {row.map((cell, c) => (
                    <td key={c} className={cn("px-2 py-1 align-top", r === 0 && "font-medium")}>
                      {inline(cell, `td${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      table = [];
    }
  };

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();

    if (line.startsWith("```")) {
      if (code) {
        blocks.push(
          <pre
            key={`code-${idx}`}
            className="my-2 overflow-x-auto rounded-lg bg-muted p-2.5 font-mono text-[11.5px] leading-relaxed"
          >
            {code.join("\n")}
          </pre>,
        );
        code = null;
      } else {
        flush();
        code = [];
      }
      return;
    }
    if (code) {
      code.push(raw);
      return;
    }

    if (!line.trim()) {
      flush();
      return;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const depth = heading[1].length;
      blocks.push(
        <div
          key={`h-${idx}`}
          className={cn(
            "mt-3 font-display font-medium text-foreground",
            depth === 1 && "text-[16px]",
            depth === 2 && "text-[14px]",
            depth >= 3 && "text-[12.5px] text-muted-foreground",
          )}
        >
          {inline(heading[2], `h${idx}`)}
        </div>,
      );
      return;
    }

    if (line.startsWith(">")) {
      flush();
      blocks.push(
        <blockquote
          key={`q-${idx}`}
          className="my-1.5 border-l-2 border-primary/40 pl-2.5 text-[12.5px] text-muted-foreground"
        >
          {inline(line.replace(/^>\s?/, ""), `q${idx}`)}
        </blockquote>,
      );
      return;
    }

    if (line.startsWith("|")) {
      // The |---|---| separator row carries no content.
      if (/^\|[-\s|:]+\|$/.test(line)) return;
      table.push(line.split("|").slice(1, -1).map((c) => c.trim()));
      return;
    }

    if (/^[-*]\s/.test(line)) {
      if (table.length) flush();
      list.push(line.replace(/^[-*]\s/, ""));
      return;
    }

    flush();
    blocks.push(
      <p key={`p-${idx}`} className="my-1 leading-relaxed">
        {inline(line, `p${idx}`)}
      </p>,
    );
  });
  flush();

  return <div className={cn("text-[13px] text-foreground", className)}>{blocks}</div>;
}
