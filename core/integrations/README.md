# Integrations

Optional integrations that extend Personal OS with external tools.

## Available Integrations

| Integration | Description | Setup |
|-------------|-------------|-------|
| *(none yet)* | Add integrations under `core/integrations/` | See below |

## Adding Integrations

Each integration folder contains:

- `README.md` - Full documentation and manual setup
- `SETUP_SKILL.md` - Skill template for automated installation
- `mcp-config.json` - MCP server configuration template

## Using Integrations

Most integrations can be set up by telling Claude:

```
Set up [integration name] for my Personal OS
```

Claude will follow the setup skill to install and configure everything.

## Contributing

To add a new integration:

1. Create a folder under `core/integrations/`
2. Add `README.md` with documentation
3. Add `SETUP_SKILL.md` with installation steps
4. Add any config templates needed
5. Update this README with the new integration
