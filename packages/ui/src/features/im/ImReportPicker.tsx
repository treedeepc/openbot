import { IM_REPORT_CATEGORIES, type ImReportCategory } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For } from "solid-js";
import { useText } from "../../text";
import { IM_REPORT_CATEGORY_LABEL } from "./im-inbox";

export function ImReportPicker(props: {
  onSubmit: (category: ImReportCategory) => void | Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useText();
  const [busy, setBusy] = createSignal(false);

  async function submit(category: ImReportCategory): Promise<void> {
    if (busy()) return;
    setBusy(true);
    try {
      await props.onSubmit(category);
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset class="im-report-picker">
      <legend class="im-report-label">{t("im.report.title")}</legend>
      <For each={IM_REPORT_CATEGORIES}>
        {(category) => (
          <Button type="button" size="xs" variant="ghost" disabled={busy()} onClick={() => void submit(category)}>
            {t(IM_REPORT_CATEGORY_LABEL[category])}
          </Button>
        )}
      </For>
      <Button type="button" size="xs" variant="ghost" onClick={() => props.onCancel()}>
        {t("im.report.cancel")}
      </Button>
    </fieldset>
  );
}

export function ImReportAction(props: {
  label: string;
  busy?: boolean | undefined;
  onReport: (category: ImReportCategory) => void | Promise<void>;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      {open() ? (
        <ImReportPicker
          onCancel={() => setOpen(false)}
          onSubmit={async (category) => {
            await props.onReport(category);
            setOpen(false);
          }}
        />
      ) : (
        <Button type="button" size="xs" variant="ghost" disabled={props.busy === true} onClick={() => setOpen(true)}>
          {props.label}
        </Button>
      )}
    </>
  );
}
