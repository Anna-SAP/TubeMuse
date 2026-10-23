import { summarizeChanges } from '../../core/learning';
import type { Change } from '../../core/types';

/** 调整明细：主要变化直接列出，细小的因子权重变化折叠起来。 */
export function ChangeList({ changes }: { changes: Change[] }) {
  const { main, minor } = summarizeChanges(changes);
  return (
    <>
      <ul>
        {main.map((c) => (
          <li>{c.explanation}</li>
        ))}
      </ul>
      {minor.length > 0 && (
        <details class="minor-changes">
          <summary>以及 {minor.length} 项小幅的因子权重调整</summary>
          <ul>
            {minor.map((c) => (
              <li>{c.explanation}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
