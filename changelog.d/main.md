### Added

- When the server you are on does not offer IM, the IM entry is now shown greyed out with a note saying so,
  and the IM page explains why nothing is listed there. Before, the entry simply vanished, which made it
  easy to conclude the feature was missing.
- Enrolling a device is now one guided flow instead of a bare form: the pairing code comes with how long it
  has left to live, the key you registered sits next to the key that came back with the challenge, and the
  fingerprint and key algorithm are shown beside them so the three can be compared line by line. The code is
  only shown and sent for checking, never compared here. When the code runs out the page says so and asks
  you to enroll again, and approving with a typed code, cancelling an enrollment and revoking a device all
  live in the same section.
- Muting a conversation now also quiets its notifications. Before, the mute switch never reached the
  notification decision, so messages kept popping up through the quiet period.
- The devices section now shows each device's fingerprint and key algorithm, and while you enroll a device
  it also shows the public key that came back with the pairing code, so the key you typed, the key that was
  registered and the fingerprint can be compared at a glance. Fingerprints always appear as eight blocks of
  four uppercase hex digits.
- The mobile app's IM conversation screen now shows the conversation controls the desktop app and the web
  client already had: muting one conversation and how much of the quiet period is left, the read receipt
  switch together with whether the other side read your messages, and the channel member list with who is
  admin, member or read-only — only admins change roles or remove someone, and a member from another
  instance never sees an "add member" button. This brings the mobile screen in line with the other two
  rather than adding a new feature.
- The mobile app's IM conversation can now send on your behalf through an assistant. You turn that on
  yourself, pick who answers, see the monthly budget for each person you talk to (default $20) and change
  it right there, and hide the "Assistant replied" mark while the record still keeps who actually
  answered. A reply refused because the budget is used up says so, and says it did not go out.
- In the web client the reply budget is no longer a fixed sentence: it shows the amount actually set
  (default $20 for each person you talk to, counted per person) and you can change it where you write,
  and a message refused for budget says it did not go out and why.
- A message that never reached the other side no longer looks sent. It shows "Not delivered" with a note
  that the peer is offline and it goes out again once they are back, and it waits in a "To send" list
  where you can resend it as it is or edit it first and then send again. When the peer comes back online
  the waiting sends go out on their own and read "Resending" until they show up as "Delivered"; a message
  that was already delivered or already withdrawn is never sent again.
- While a device is waiting to be approved you can now cancel its enrollment instead of letting it sit
  until the pairing code expires; the device then simply never becomes active.
- The mobile app's IM conversation now matches the desktop and the web client: you can withdraw your own
  message within two minutes (after that it says it is too late), see whether the other side read it and
  turn read receipts off, resend a message that did not go out, mute one conversation and see how long
  is left, and view the channel members with who is admin, member or read-only — only admins can change
  roles or remove someone, and an external member never sees an "add member" button.
- An IM conversation can now show you more: you can withdraw your own message within two minutes (it
  withdraws at once and the text is replaced by a notice; after two minutes it says it is too late),
  see whether the other side read it, turn read receipts off, and resend a message that did not go
  out. You can also mute a single conversation for a while and see how long is left, and the channel
  member list shows who is admin, member or read-only — only admins can change roles or remove
  someone, and an external member never sees an "add member" button at all.
- Settings has a new IM section. It decides whether assistants may reply for you (off until you turn it
  on), how much those replies to one person may cost you every month (default $20, counted separately
  for each person you talk to, saved on the host), and whether those replies say who actually answered.
  It also holds
  what you get notified about, a mute switch that goes quiet for a while and then comes back on its
  own, and how other people find you: over the local network, through your own server, or by search
  (search is off until you turn it on).
- The desktop app now opens the same IM conversation page from its left rail, with the same look as the
  web client and the mobile app. The conversation shows who spoke each message and never sends on its
  own. Conversations appear there as soon as the host advertises its thread list.
- When you let an assistant reply on your behalf in an IM conversation, the message says so: it is
  marked "Assistant replied" unless you turn the mark off, and the record still keeps who actually
  replied. That kind of reply draws on a $20 monthly budget counted separately for each person you talk to, and
  when the budget is used up the message is refused and the composer says it did not go out.
- An IM conversation with an assistant on another OpenBot instance is now reachable from the left rail
  in the web client and from the server drawer in the mobile app. It shows the messages you and that
  assistant exchanged, who spoke each one, and whether each of your messages is submitted, received
  or read. The rest of the IM surface — inbox, contacts, devices, blocking and reports — stays hidden
  until its own capability ships, and nothing in the web client or the mobile app sends on its own.
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

- Turning off read receipts for a conversation now takes effect. Before, the switch was remembered only on this device and receipts were still sent.

- A CRM panel keeps its background in a transparent window. Before, the panel was see-through and the
  customer list behind it showed in the panel.

### Added

- Devices for an assistant on another OpenBot instance can be listed, enrolled, approved and revoked from the IM devices section. The section appears once the instance advertises device support.
- The IM inbox, contacts, blocklist and report sections now appear when the other OpenBot instance
  advertises those features. Before, only sessions and devices were shown.
