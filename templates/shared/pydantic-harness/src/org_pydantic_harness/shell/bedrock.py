"""Bedrock model with prompt caching (shell).

Uses ``BedrockConverseModel`` + ``BedrockProvider`` (``pydantic_ai/models/bedrock.py``,
``pydantic_ai/providers/bedrock.py``). Prompt caching is requested through the model's default
settings:

* ``bedrock_cache_instructions``: cache point after the system prompt (stable per agent);
* ``bedrock_cache_tool_definitions``: cache point after the tool list (fixed per session);
* ``bedrock_cache_messages``: cache point on the last user message (conversation prefix).

Pydantic AI only applies these where the model profile says Bedrock supports them
(``bedrock_supports_prompt_caching`` / ``bedrock_supports_tool_caching``: Anthropic Claude and
Amazon Nova families); for other models the settings are ignored, so they are safe to leave on.
``supports_prompt_caching`` reports what applies for a given model.

With an *application inference profile ARN* as model id, Pydantic AI cannot infer the model family
from the id. Pass the base model id as ``model_id`` and the ARN as ``inference_profile``: the
profile (and therefore caching support) comes from the base id, requests go to the ARN.
"""

from __future__ import annotations

from org_agents.domain import AwsRegion, ModelId
from pydantic_ai.models.bedrock import BedrockConverseModel, BedrockModelSettings
from pydantic_ai.providers.bedrock import BedrockProvider


def prompt_cache_settings() -> BedrockModelSettings:
    return BedrockModelSettings(
        bedrock_cache_instructions=True,
        bedrock_cache_tool_definitions=True,
        bedrock_cache_messages=True,
    )


def bedrock_model(
    model_id: ModelId, region: AwsRegion, *, inference_profile: ModelId | None = None
) -> BedrockConverseModel:
    settings = prompt_cache_settings()
    if inference_profile is not None:
        settings["bedrock_inference_profile"] = inference_profile.value
    return BedrockConverseModel(
        model_id.value, provider=BedrockProvider(region_name=region.value), settings=settings
    )


def supports_prompt_caching(model: BedrockConverseModel) -> bool:
    return bool(model.profile.get("bedrock_supports_prompt_caching", False))
