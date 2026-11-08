import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const HOST_CERTIFICATE_EXPLANATION = 'Proxy MCP needs permission to trust its debugging certificate in your login Keychain so it can inspect HTTPS traffic routed through the local proxy.\n\nThis step does not request access to saved Keychain passwords. Enter your Mac password only in the macOS security dialog that follows.\n\nCertificate trust remains until removed and is broader than your chosen capture scope. Captured data is stored locally and can be returned to connected MCP clients.';

export const HOST_CERTIFICATE_DIALOG = `on run arguments
  try
    set answer to display dialog (item 1 of arguments) with title "Proxy MCP — Certificate Permission" buttons {"Cancel", "Continue"} default button "Cancel" cancel button "Cancel" with icon caution giving up after 120
    if gave up of answer then return "cancelled"
    return button returned of answer
  on error number -128
    return "cancelled"
  end try
end run`;

export async function confirmHostCertificateTrust({ execute = execFileP } = {}) {
  let result;
  try {
    result = await execute('/usr/bin/osascript', ['-e', HOST_CERTIFICATE_DIALOG, HOST_CERTIFICATE_EXPLANATION], {
      timeout: 125_000, maxBuffer: 64 * 1024,
    });
  } catch {
    throw Object.assign(new Error('The certificate permission explanation could not be displayed. No certificate was installed.'), {
      code: 'HOST_CA_EXPLANATION_UNAVAILABLE',
      recovery: 'Run certificate setup from an interactive macOS login session and retry.',
    });
  }
  if (result.stdout.trim() !== 'Continue') {
    throw Object.assign(new Error('Certificate setup was cancelled. No certificate was installed.'), {
      code: 'HOST_CA_TRUST_CANCELLED',
      recovery: 'Retry certificate setup when you are ready to approve it.',
    });
  }
}
