<script lang="ts">
  // A password manager ties a saved passphrase to a username. This field is present but not visible, so the manager
  // finds a user name next to the passphrase. It is not `hidden` and not `display:none`, because managers skip those.
</script>

<input
  type="text"
  name="username"
  autocomplete="username"
  value="claude-rc-ssh"
  readonly
  tabindex="-1"
  aria-hidden="true"
  class="sr-only"
/>
