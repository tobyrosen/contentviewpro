import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ParagraphState } from "../lib/api";

interface Props {
  paragraph: ParagraphState;
  readonly?: boolean;
  onApprove: () => void;
  onUpdateNotes: (notes: string) => void;
  onRevise: () => void;
}

export default function ParagraphCard({
  paragraph,
  readonly,
  onApprove,
  onUpdateNotes,
  onRevise,
}: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: paragraph.index,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isApproved = paragraph.status === "approved";
  const isRevised = paragraph.status === "revised";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-lg border mb-4 overflow-hidden"
      {...attributes}
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-4 py-2 text-sm"
        style={{
          background: isApproved
            ? "rgba(34, 197, 94, 0.1)"
            : isRevised
              ? "rgba(245, 158, 11, 0.1)"
              : "var(--color-surface)",
          borderBottom: `1px solid var(--color-border)`,
        }}
      >
        <div className="flex items-center gap-3">
          {/* Drag handle — disabled when readonly */}
          <button
            className={
              readonly
                ? "text-lg leading-none opacity-30 cursor-default"
                : "cursor-grab active:cursor-grabbing text-lg leading-none"
            }
            style={{ color: "var(--color-text-muted)" }}
            {...(readonly ? {} : listeners)}
          >
            &#x2630;
          </button>
          <span style={{ color: "var(--color-text-muted)" }}>
            Paragraph {paragraph.index + 1}
          </span>
          {isApproved && (
            <span
              className="text-xs font-medium"
              style={{ color: "var(--color-approved)" }}
            >
              Approved
            </span>
          )}
          {isRevised && (
            <span
              className="text-xs font-medium"
              style={{ color: "var(--color-revised)" }}
            >
              Has Notes
            </span>
          )}
        </div>

        {!readonly && (
          <div className="flex gap-2">
            {isApproved ? (
              <button
                onClick={onRevise}
                className="px-3 py-1 rounded text-xs font-medium transition-colors"
                style={{
                  background: "var(--color-border)",
                  color: "var(--color-text-muted)",
                }}
              >
                Undo
              </button>
            ) : (
              <button
                onClick={onApprove}
                className="px-3 py-1 rounded text-xs font-medium transition-colors"
                style={{
                  background: "var(--color-approved)",
                  color: "#000",
                }}
              >
                Approve
              </button>
            )}
          </div>
        )}
      </div>

      {/* Two-panel layout */}
      <div
        className="grid grid-cols-2 divide-x"
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-border)",
        }}
      >
        {/* Left: paragraph text */}
        <div className="p-5">
          <p
            className="text-sm leading-relaxed whitespace-pre-wrap"
            style={{ color: "var(--color-text)" }}
          >
            {paragraph.original}
          </p>
        </div>

        {/* Right: notes area */}
        <div className="p-4">
          {isApproved ? (
            <p
              className="text-sm italic"
              style={{ color: "var(--color-text-muted)" }}
            >
              Approved — no notes needed
            </p>
          ) : readonly ? (
            <div
              className="w-full min-h-[100px] rounded p-3 text-sm leading-relaxed whitespace-pre-wrap"
              style={{
                background: "var(--color-bg)",
                color: "var(--color-text-muted)",
                border: `1px solid var(--color-border)`,
                opacity: 0.6,
              }}
            >
              {paragraph.notes || ""}
            </div>
          ) : (
            <textarea
              value={paragraph.notes || ""}
              onChange={(e) => onUpdateNotes(e.target.value)}
              placeholder="Rewrite, rough draft, or notes..."
              className="w-full h-full min-h-[100px] resize-none rounded p-3 text-sm leading-relaxed outline-none"
              style={{
                background: "var(--color-bg)",
                color: "var(--color-text)",
                border: `1px solid var(--color-border)`,
              }}
              onFocus={(e) =>
                (e.currentTarget.style.borderColor = "var(--color-primary)")
              }
              onBlur={(e) =>
                (e.currentTarget.style.borderColor = "var(--color-border)")
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
