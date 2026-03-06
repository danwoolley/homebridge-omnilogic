# homebridge-omnilogic

Homebridge plugin for **Hayward OmniLogic** pool/spa controllers. Exposes OmniLogic Themes (called "Groups" in the protocol) as HomeKit Switches, so you can activate preset pool/spa configurations from Apple Home and Siri.

Communicates locally via UDP — no cloud dependency.

## Features

- Automatic discovery of all Themes/Groups configured on your OmniLogic controller
- Each Theme appears as a HomeKit Switch (on/off)
- State polling keeps HomeKit in sync with the controller
- Fully local communication over UDP (port 10444)

## Requirements

- Homebridge v1.6.0 or later
- Node.js v18, v20, or v22
- Hayward OmniLogic controller on the same local network

## Installation

### Via Homebridge UI

Search for `homebridge-omnilogic` in the Homebridge UI plugin tab and click Install.

### Via CLI

```bash
npm install -g homebridge-omnilogic
```

## Configuration

Add the following to the `platforms` array in your Homebridge `config.json`:

```json
{
    "platform": "OmniLogic",
    "name": "OmniLogic",
    "host": "192.168.1.XXX"
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `platform` | Yes | — | Must be `"OmniLogic"` |
| `name` | Yes | — | Display name in Homebridge logs |
| `host` | Yes | — | IP address of your OmniLogic controller |
| `pollingInterval` | No | `30` | How often (in seconds) to poll for state updates |

### Finding Your Controller IP

Your OmniLogic controller should be visible on your local network. You can find it by:

- Checking your router's DHCP client list (look for "OmniLogic" or a Hayward device)
- Running `arp -a` and looking for `haywardomnilogic` in the hostname
- Checking the controller's touchscreen under Settings > Network

## How It Works

The plugin communicates directly with your OmniLogic controller over UDP on port 10444 using the same local protocol as the Hayward app. On startup it fetches the controller's configuration to discover all Themes, then polls telemetry at the configured interval to keep switch states in sync.

When you toggle a switch in HomeKit, the plugin sends a command to the controller to activate or deactivate that Theme.

## Troubleshooting

**Switches show "Not Responding"**
- Verify the controller IP is correct and reachable from your Homebridge server
- Check that UDP port 10444 is not blocked by a firewall
- Check Homebridge logs for error messages

**No accessories appear**
- Make sure you have at least one Theme configured on your OmniLogic controller
- Check Homebridge logs for discovery errors

## License

MIT
