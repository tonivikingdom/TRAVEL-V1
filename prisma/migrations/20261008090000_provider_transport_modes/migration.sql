-- Add explicit cycling and aggregate public-transit modes without changing existing facts.
ALTER TYPE "TransportMode" ADD VALUE 'CYCLING';
ALTER TYPE "TransportMode" ADD VALUE 'TRANSIT';
