import re
from typing import Dict

VAR_PATTERN = re.compile(r"\{\{([a-zA-Z0-9_]+)\}\}")


def render_template(text: str, variables: Dict[str, str]) -> str:
    def repl(m: re.Match[str]) -> str:
        key = m.group(1)
        return str(variables.get(key, ""))

    return VAR_PATTERN.sub(repl, text)
