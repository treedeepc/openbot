### Added

- You can now add files and a folder from your computer to an agent's Library. OpenBot copies them
  into its own storage and keeps the folder structure you pick, so the files on your disk stay
  untouched and removing them from the Library never removes the originals. When it cannot add
  something, such as a hidden item or a folder deeper than five levels, it lists that item and why.
- The Library page offers Add files and Add folder in the desktop app. The web client does not show
  them, because a browser cannot pick files from your disk.
- Two keyboard shortcuts in the desktop app: Shift+Cmd+A opens the assistants page, and Shift+Cmd+S
  moves to the next menu module in the left rail. Use Ctrl instead of Cmd on Windows and Linux. Both
  are listed in Settings, where you can give each one your own keys, turn it off, or put the default
  back.
- A task in a channel chat now says what it is waiting for and how long it has gone without progress.
  A task that no member picked up, and a turn a provider stopped for making no progress, both show up
  as stuck instead of leaving only one message in the chat. You can carry on with a new requirement,
  hand the work to another member, or drop it, and a message that never reached its assistant can be
  sent again.
- A stuck task in a channel chat can now be cut loose at once. The channel's lead can stop or drop a
  run that another member owns, and you can drop a task without stopping it first. Stopping cuts the
  running turn and frees its slot, so the next queued task can start right away. The task stays and
  can be carried on later.

### Changed

- The list of subtasks above the composer now marks the row under the pointer, and double-clicking a
  row opens its details, with the actions you can take on that subtask in the dialog. You can also
  run a subtask from its row or its details, next to Stop.
- That list now says how long a subtask has gone without progress and why it is waiting, colours the
  row when it is slow or stuck, and warns at the top when one is stuck. From its details you can hand
  the work to another member or drop it, and send again a message that never reached its assistant.
- The side panel now collapses when you close its last tab. Before, it stayed open and showed the
  launcher. A side panel that you opened from the panel button stays open, so it is never taken away
  from you while you use it.
- An agent can now create, change and delete CRM customers, plans and payments, and the change takes
  effect at once. Before, the change waited as a proposal and an owner or an admin had to approve it
  on the CRM page. A row that comes from a source, such as a Stripe import, is still read-only.

### Fixed

- A CRM panel keeps its background in a transparent window. Before, the panel was see-through and the
  customer list behind it showed in the panel.
