from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse


def add_utm(
    url: str,
    source: str,
    medium: str,
    campaign: str,
    content: str | None = None,
    term: str | None = None,
) -> str:
    parts = urlparse(url)
    qs = dict(parse_qsl(parts.query, keep_blank_values=True))
    qs["utm_source"] = source
    qs["utm_medium"] = medium
    qs["utm_campaign"] = campaign
    if content:
        qs["utm_content"] = content
    if term:
        qs["utm_term"] = term
    new_query = urlencode(qs, doseq=True)
    return urlunparse((parts.scheme, parts.netloc, parts.path, parts.params, new_query, parts.fragment))
